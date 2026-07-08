const TelegramChat = require('../models/TelegramChat');
const telegramBot = require('./telegramBot');
const metricsService = require('./metricsService');
const logger = require('../utils/logger');

const AVAILABLE_LIKE = new Set(['available', 'maybe_available']);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function fuelLabel(fuelType) {
  return /^\d+$/.test(fuelType) ? `АИ-${fuelType}` : fuelType;
}

function chatMatchesFilters(chat, station, fuelType) {
  const isWatchlisted = chat.watchlist.some((id) => String(id) === String(station._id));
  if (isWatchlisted) return true;
  if (chat.fuelTypes.length && !chat.fuelTypes.includes(fuelType)) return false;
  if (chat.brands.length && !chat.brands.includes(station.name)) return false;
  return true;
}

async function getCandidateChats(region, station, eventKey) {
  return TelegramChat.find({
    status: 'active',
    [`events.${eventKey}`]: true,
    $or: [{ regions: region._id }, { watchlist: station._id }],
  });
}

function formatStationEvent({ eventKey, station, region, fuelType }) {
  const emoji = eventKey === 'stationAvailable' ? '🟢' : '🔴';
  const verb = eventKey === 'stationAvailable' ? 'появилось' : 'пропало';
  const lines = [
    `${emoji} <b>${escapeHtml(station.name || 'АЗС')}</b>`,
    station.address ? escapeHtml(station.address) : null,
    `Топливо ${fuelLabel(fuelType)}: ${verb}`,
    `Район: ${escapeHtml(region.name)}`,
  ].filter(Boolean);
  return lines.join('\n');
}

/**
 * Compares a station's fuel-type statuses before/after a poll and notifies
 * any chat that cares. Called from ingestService right after a station is
 * stored - must never throw (a Telegram hiccup should never break ingestion),
 * so callers should still wrap this in their own try/catch as a last resort,
 * but every await inside here is already best-effort.
 */
async function handleStationUpdate({ station, region, previousFuelStatuses, newFuelStatuses }) {
  if (!telegramBot.isEnabled()) return;

  const prevByType = new Map((previousFuelStatuses || []).map((f) => [f.fuelType, f.status]));

  for (const f of newFuelStatuses || []) {
    const prevStatus = prevByType.has(f.fuelType) ? prevByType.get(f.fuelType) : null;
    // A fuel type seen for the first time isn't a transition - there's
    // nothing to compare against, so it can't have "become" anything yet.
    if (prevStatus === null) continue;

    const wasAvailable = AVAILABLE_LIKE.has(prevStatus);
    const isAvailable = AVAILABLE_LIKE.has(f.status);

    let eventKey = null;
    if (isAvailable && !wasAvailable) eventKey = 'stationAvailable';
    else if (!isAvailable && wasAvailable && f.status === 'not_available') eventKey = 'stationUnavailable';
    if (!eventKey) continue;

    try {
      const candidates = await getCandidateChats(region, station, eventKey);
      const matched = candidates.filter((c) => chatMatchesFilters(c, station, f.fuelType));
      if (!matched.length) continue;
      const text = formatStationEvent({ eventKey, station, region, fuelType: f.fuelType });
      await telegramBot.sendToChats(matched, () => text);
    } catch (err) {
      logger.error(`Telegram notify failed for station ${station._id}, fuel ${f.fuelType}:`, err.message);
    }
  }
}

async function buildRegionSummaryText(region, { from, to }) {
  const stations = await metricsService.getStationMetrics(region._id, { from, to });
  if (!stations.length) return `«${region.name}»: нет данных за этот период.`;

  let weightedAvailable = 0;
  let weightForAvailable = 0;
  let totalOutages = 0;
  for (const s of stations) {
    if (s.availablePct !== null) {
      weightedAvailable += s.availablePct * s.totalPolls;
      weightForAvailable += s.totalPolls;
    }
    totalOutages += s.outageCount;
  }
  const overallPct = weightForAvailable > 0 ? weightedAvailable / weightForAvailable : null;
  const pctLabel = overallPct === null ? 'нет данных' : `${overallPct.toFixed(0)}%`;

  return [
    `📊 <b>${escapeHtml(region.name)}</b>`,
    `Доступность: ${pctLabel}`,
    `Станций: ${stations.length}`,
    `Отключений за период: ${totalOutages}`,
  ].join('\n');
}

/**
 * Builds and sends one digest message per chat, one section per subscribed
 * region concatenated together (a chat can watch several regions at once).
 */
async function sendDigest(period) {
  if (!telegramBot.isEnabled()) return;
  const eventKey = period === 'daily' ? 'dailyDigest' : 'hourlyDigest';
  const lastFieldKey = period === 'daily' ? 'lastDailyDigestAt' : 'lastHourlyDigestAt';
  const spanMs = period === 'daily' ? 24 * 3600 * 1000 : 3600 * 1000;

  const chats = await TelegramChat.find({ status: 'active', [`events.${eventKey}`]: true }).populate('regions');
  const to = new Date();
  const from = new Date(to.getTime() - spanMs);

  // Digests are checked on a short interval (see telegramDigestScheduler),
  // not sent every tick - a chat is only actually due once spanMs has
  // passed since its own last digest, which also makes this self-healing
  // across restarts (no cron alignment to worry about).
  const dueChats = chats.filter((chat) => {
    if (!chat.regions.length) return false;
    const last = chat[lastFieldKey];
    return !last || to.getTime() - new Date(last).getTime() >= spanMs;
  });

  for (const chat of dueChats) {
    try {
      const sections = await Promise.all(
        chat.regions.map((region) => buildRegionSummaryText(region, { from: from.toISOString(), to: to.toISOString() }))
      );
      const title = period === 'daily' ? '🗓 Дневная сводка' : '🕐 Часовая сводка';
      const text = [`${title}`, ...sections].join('\n\n');
      await telegramBot.sendMessage(chat, text);
      chat[lastFieldKey] = to;
      await chat.save();
    } catch (err) {
      logger.error(`Telegram digest failed for chat ${chat.chatId}:`, err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

module.exports = { handleStationUpdate, sendDigest, escapeHtml };
