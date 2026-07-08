const TelegramChat = require('../models/TelegramChat');
const telegramBot = require('./telegramBot');
const metricsService = require('./metricsService');
const logger = require('../utils/logger');

const AVAILABLE_LIKE = new Set(['available', 'maybe_available']);
// Telegram's real cap is 4096 chars; keep a margin so HTML entity escaping
// (e.g. "&amp;" for "&") can't push a chunk over the limit.
const MAX_MESSAGE_LEN = 3500;

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

/**
 * Compares a station's fuel-type statuses before/after a poll and returns
 * the list of appeared/disappeared transitions. Pure and synchronous - no
 * chat lookup or sending here, so a whole region's worth of these can be
 * collected first and sent as one batch (see notifyRegionChanges) instead
 * of firing a message the instant each station is stored.
 */
function computeTransitions(previousFuelStatuses, newFuelStatuses) {
  const prevByType = new Map((previousFuelStatuses || []).map((f) => [f.fuelType, f.status]));
  const transitions = [];

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
    if (eventKey) transitions.push({ fuelType: f.fuelType, eventKey });
  }

  return transitions;
}

function formatStationBlock(station, transitions) {
  const lines = [
    `<b>${escapeHtml(station.name || 'АЗС')}</b>`,
    station.address ? escapeHtml(station.address) : null,
    ...transitions.map(({ fuelType, eventKey }) => {
      const emoji = eventKey === 'stationAvailable' ? '🟢' : '🔴';
      const verb = eventKey === 'stationAvailable' ? 'появилось' : 'пропало';
      return `${emoji} ${fuelLabel(fuelType)}: ${verb}`;
    }),
  ].filter(Boolean);
  return lines.join('\n');
}

// Packs per-station blocks into as few messages as possible while staying
// under Telegram's length limit - a poll can change many stations at once,
// and one message covering all of them beats one message per station, but
// it still has to fit.
function chunkMessages(header, blocks) {
  const messages = [];
  let current = header;
  for (const block of blocks) {
    const candidate = `${current}\n\n${block}`;
    if (candidate.length > MAX_MESSAGE_LEN && current !== header) {
      messages.push(current);
      current = `${header}\n\n${block}`;
    } else {
      current = candidate;
    }
  }
  messages.push(current);
  return messages;
}

/**
 * Sends one batch of Telegram messages per chat covering every station
 * whose fuel availability changed in a single region poll, grouped by
 * station (a station with several fuel types changing at once gets one
 * block, not one message per fuel type). Called once per poll, after all
 * of a region's stations have been stored - must never throw, callers
 * should still wrap this in their own try/catch as a last resort, but
 * every await inside here is already best-effort per chat.
 *
 * `stationEvents` is `[{ station, transitions }]`, where `transitions` is
 * whatever `computeTransitions` returned for that station (already
 * filtered to non-empty by the caller).
 */
async function notifyRegionChanges(region, stationEvents) {
  if (!telegramBot.isEnabled() || !stationEvents.length) return;

  const changedStationIds = stationEvents.map((e) => e.station._id);
  const chats = await TelegramChat.find({
    status: 'active',
    $and: [
      { $or: [{ 'events.stationAvailable': true }, { 'events.stationUnavailable': true }] },
      { $or: [{ regions: region._id }, { watchlist: { $in: changedStationIds } }] },
    ],
  });
  if (!chats.length) return;

  await telegramBot.sendToChats(chats, (chat) => {
    const blocks = [];
    for (const { station, transitions } of stationEvents) {
      const relevant = transitions.filter(
        ({ eventKey, fuelType }) => chat.events[eventKey] && chatMatchesFilters(chat, station, fuelType)
      );
      if (relevant.length) blocks.push(formatStationBlock(station, relevant));
    }
    if (!blocks.length) return [];

    const header =
      blocks.length === 1
        ? `Изменение топлива — ${escapeHtml(region.name)}`
        : `Изменения топлива (${blocks.length} ст.) — ${escapeHtml(region.name)}`;
    return chunkMessages(header, blocks);
  });
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
      // metricsService compares these against the Date-typed polledAt field
      // directly (no casting) - passing ISO strings here instead of Date
      // objects made every digest match zero snapshots (Mongo ranks the Date
      // BSON type above String, so a Date field is never <= a string value),
      // which is why every digest used to say "no data" no matter what.
      const sections = await Promise.all(
        chat.regions.map((region) => buildRegionSummaryText(region, { from, to }))
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

module.exports = { computeTransitions, notifyRegionChanges, sendDigest, escapeHtml };
