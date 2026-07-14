const TelegramChat = require('../models/TelegramChat');
const Station = require('../models/Station');
const telegramBot = require('./telegramBot');
const telegramDigestData = require('./telegramDigestData');
const telegramDigestImage = require('./telegramDigestImage');
const telegramAlertMapImage = require('./telegramAlertMapImage');
const telegramPredictiveAlerts = require('./telegramPredictiveAlerts');
const telegramPromoContent = require('./telegramPromoContent');
const { CORE_FUEL_TYPES } = require('./metricsService');
const { escapeHtml } = require('../utils/escapeHtml');
const logger = require('../utils/logger');

// Telegram's real cap is 4096 chars; keep a margin so HTML entity escaping
// (e.g. "&amp;" for "&") can't push a chunk over the limit.
const MAX_MESSAGE_LEN = 3500;

function fuelLabel(fuelType) {
  return /^\d+$/.test(fuelType) ? `АИ-${fuelType}` : fuelType;
}

function chatMatchesFilters(chat, station, fuelType) {
  const isWatchlisted = chat.watchlist.some((id) => String(id) === String(station._id));
  if (isWatchlisted) return true;
  // An admin who explicitly listed fuel types in chat settings gets exactly
  // those, unchanged; a chat that never configured this (the common case)
  // used to mean "every fuel type this station reports" - including
  // propane/98/100, which most subscribers don't drive on and don't care to
  // be pinged about. Defaults to CORE_FUEL_TYPES instead (see
  // metricsService.js's own doc comment), same "unconfigured = 92/95"
  // default already applied to the map badge/reports/digest/predictive
  // alerts - not "no filter" anymore.
  const allowedFuelTypes = chat.fuelTypes.length ? chat.fuelTypes : CORE_FUEL_TYPES;
  if (!allowedFuelTypes.includes(fuelType)) return false;
  if (chat.brands.length && !chat.brands.includes(station.name)) return false;
  return true;
}

// Same idea as chatMatchesFilters, minus the fuel-type check - a predictive
// alert is about a station as a whole, not a specific fuel type, so a
// chat's fuelTypes filter (which only makes sense for a per-fuel-type
// transition) doesn't apply here.
function chatMatchesStation(chat, station) {
  const isWatchlisted = chat.watchlist.some((id) => String(id) === String(station._id));
  if (isWatchlisted) return true;
  if (chat.brands.length && !chat.brands.includes(station.name)) return false;
  return true;
}

// Statuses that update a fuel type's "confirmed" memory (see
// computeTransitions below and Station.js's own doc comment on
// confirmedFuelStatuses) - a real positive or negative claim, not the
// ambiguous middle ground (maybe_available/no_data) that a station spends a
// lot of its time flickering through in practice.
const CONFIRMABLE_STATUSES = new Set(['available', 'not_available']);

/**
 * Compares a station's fuel-type statuses before/after a poll and returns
 * the list of appeared/disappeared transitions, plus the next
 * confirmedFuelStatuses the caller should persist. Pure and synchronous -
 * no chat lookup, sending, or DB write here, so a whole region's worth of
 * these can be collected first and sent as one batch (see
 * notifyRegionChanges) instead of firing a message the instant each
 * station is stored.
 *
 * Deliberately compares against `previousConfirmedFuelStatuses` (a longer-
 * memory value, only ever updated by a literal available/not_available
 * reading - see Station.js's own doc comment) rather than
 * `previousRawFuelStatuses` (the immediately-prior single poll) for
 * deciding whether a transition is real. An earlier version compared
 * against the raw previous poll directly, which - confirmed live as a
 * common production pattern, a station flapping available <-> maybe_available
 * dozens of times in its own history - had two symmetric problems: it
 * re-fired "появилось" on every maybe_available -> available flip (nothing
 * had actually changed since the last confirmed "available"), and it
 * silently missed genuine available -> ... -> not_available transitions
 * whenever the one poll right before the not_available reading happened to
 * land on maybe_available (the single-hop comparison saw
 * maybe_available -> not_available, which isn't the tracked
 * available -> not_available pair). Comparing against a value that only
 * moves on confirmed readings fixes both: a run of maybe_available polls
 * between two confirmed readings is invisible to this comparison, exactly
 * as it should be.
 *
 * `previousRawFuelStatuses` is still needed separately, only to tell "this
 * fuel type has never been seen before at all" (skip - nothing to compare
 * against yet) apart from "seen before but never confirmed either way"
 * (prevConfirmed is null/absent, a legitimate transition target).
 */
function computeTransitions(previousRawFuelStatuses, previousConfirmedFuelStatuses, newFuelStatuses) {
  const prevRawByType = new Map((previousRawFuelStatuses || []).map((f) => [f.fuelType, f.status]));
  const nextConfirmedByType = new Map((previousConfirmedFuelStatuses || []).map((f) => [f.fuelType, f.status]));
  const transitions = [];

  for (const f of newFuelStatuses || []) {
    if (!CONFIRMABLE_STATUSES.has(f.status)) continue; // maybe_available/no_data never move the memory

    const everSeenBefore = prevRawByType.has(f.fuelType);
    if (everSeenBefore) {
      const prevConfirmed = nextConfirmedByType.get(f.fuelType) ?? null;
      let eventKey = null;
      if (f.status === 'available' && prevConfirmed !== 'available') eventKey = 'stationAvailable';
      else if (f.status === 'not_available' && prevConfirmed === 'available') eventKey = 'stationUnavailable';
      if (eventKey) transitions.push({ fuelType: f.fuelType, eventKey });
    }

    nextConfirmedByType.set(f.fuelType, f.status);
  }

  const nextConfirmedFuelStatuses = [...nextConfirmedByType].map(([fuelType, status]) => ({ fuelType, status }));
  return { transitions, nextConfirmedFuelStatuses };
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

function computeRelevantBlocks(chat, stationEvents) {
  const blocks = [];
  for (const { station, transitions } of stationEvents) {
    const relevant = transitions.filter(
      ({ eventKey, fuelType }) => chat.events[eventKey] && chatMatchesFilters(chat, station, fuelType)
    );
    if (relevant.length) blocks.push(formatStationBlock(station, relevant));
  }
  return blocks;
}

// Telegram photo captions are capped at 1024 chars, much tighter than a
// plain message's 4096 (MAX_MESSAGE_LEN) - shared with sendDigest's own
// buildCaption below, which has the same limit for the same reason.
const MAX_CAPTION_LEN = 1024;

// Same idea as chunkMessages, but for a photo caption: appends whole
// blocks only (never mid-block, so a truncation can't cut an HTML tag in
// half), and - unlike buildCaption below, which just drops whatever
// doesn't fit - also reports back which blocks didn't make it in, so the
// caller can send those as a follow-up text message instead of losing
// them. A fuel-availability alert's whole point is the per-station
// detail, so silently dropping the tail (fine for a digest, which is a
// summary by nature) isn't acceptable here.
function buildCaptionWithRemainder(title, blocks) {
  let caption = title;
  let includedCount = 0;
  for (const block of blocks) {
    const candidate = `${caption}\n\n${block}`;
    if (candidate.length > MAX_CAPTION_LEN) break;
    caption = candidate;
    includedCount += 1;
  }
  return { caption, remainder: blocks.slice(includedCount) };
}

async function sendChunkedText(chat, header, blocks) {
  if (!blocks.length) return;
  for (const text of chunkMessages(header, blocks)) {
    await telegramBot.sendMessage(chat, text);
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

/**
 * Sends the combined image+text post for one chat with an alertMapBbox
 * configured (see TelegramChat.js) - the map+stats image
 * (telegramAlertMapImage.js) with as much of the alert text as fits as
 * its caption, so this lands as one post instead of an image followed by
 * a separate message. Whatever doesn't fit in the 1024-char caption goes
 * out right after as its own chunked text message(s) (see
 * buildCaptionWithRemainder) - only actually happens on an unusually busy
 * tick (many stations changing at once); the common case of one or two
 * stations fits in a single caption with room to spare.
 *
 * Falls back to plain chunked text entirely (same as a chat with no
 * bbox) if the image itself fails to render or send, so a rendering hiccup
 * never costs a chat the alert altogether.
 */
async function sendAlertMapPost(chat, region, header, blocks) {
  try {
    const { minLat, maxLat, minLon, maxLon } = chat.alertMapBbox;
    const stations = await Station.find({
      regions: region._id,
      lat: { $gte: minLat, $lte: maxLat },
      lon: { $gte: minLon, $lte: maxLon },
    })
      .select('lat lon lastStatus lastFuelStatuses')
      .lean();
    const buffer = await telegramAlertMapImage.renderAlertMapImage({
      bbox: chat.alertMapBbox,
      stations,
      visibleStatuses: chat.alertMapStatuses,
    });
    const { caption, remainder } = buildCaptionWithRemainder(header, blocks);
    const sent = await telegramBot.sendPhoto(chat, buffer, caption);
    if (!sent) throw new Error('sendPhoto returned false');
    await sendChunkedText(chat, header, remainder);
  } catch (err) {
    logger.error(`Telegram alert map image failed for chat ${chat.chatId}, falling back to text:`, err.message);
    await sendChunkedText(chat, header, blocks);
  }
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

  for (const chat of chats) {
    const blocks = computeRelevantBlocks(chat, stationEvents);
    if (!blocks.length) continue;

    const header =
      blocks.length === 1
        ? `Изменение топлива — ${escapeHtml(region.name)}`
        : `Изменения топлива (${blocks.length} ст.) — ${escapeHtml(region.name)}`;

    if (chat.alertMapBbox) {
      await sendAlertMapPost(chat, region, header, blocks);
    } else {
      await sendChunkedText(chat, header, blocks);
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

const RU_DATE_TZ = 'Europe/Moscow';
const dateFmt = new Intl.DateTimeFormat('ru-RU', { timeZone: RU_DATE_TZ, day: '2-digit', month: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('ru-RU', { timeZone: RU_DATE_TZ, hour: '2-digit', minute: '2-digit' });

function formatPeriodLabel(period, from, to) {
  const title = period === 'daily' ? 'Дневная сводка' : 'Часовая сводка';
  const range = period === 'daily' ? `${dateFmt.format(from)}–${dateFmt.format(to)}` : `${dateFmt.format(to)} ${timeFmt.format(from)}–${timeFmt.format(to)}`;
  return `${title} · ${range}`;
}

// The image already carries the headline number (current %), status
// breakdown and trend - this text complements it with what doesn't fit
// cleanly into a compact card: exact outage count and the most reliable
// stations in the period (with address), rather than dwelling on what's
// currently broken.
function formatRegionDigestText(data) {
  const lines = [`<b>${escapeHtml(data.region.name)}</b>`, `Отключений за период: ${data.totalOutages}`];
  if (data.topAvailableStations.length) {
    lines.push('Самые доступные станции:');
    data.topAvailableStations.forEach(({ name, address, availablePct }, i) => {
      const addressPart = address ? `, ${escapeHtml(address)}` : '';
      lines.push(`${i + 1}. ${escapeHtml(name || 'АЗС')}${addressPart} — ${availablePct.toFixed(0)}%`);
    });
  }
  return lines.join('\n');
}

// Builds a digest's photo/media-group caption (MAX_CAPTION_LEN defined
// above) by appending whole region sections only, never mid-section, so a
// chat following many regions just loses the tail end of sections rather
// than risking a truncation that cuts an HTML tag in half (which would
// make Telegram reject the send). Unlike buildCaptionWithRemainder above,
// a dropped tail here is fine - a digest is a summary by nature, and
// there's no follow-up message for the overflow.
function buildCaption(title, sections) {
  let caption = title;
  for (const section of sections) {
    const candidate = `${caption}\n\n${section}`;
    if (candidate.length > MAX_CAPTION_LEN) break;
    caption = candidate;
  }
  return caption;
}

/**
 * Builds and sends one digest post per chat: an image card per followed
 * region (as an album, or a single photo if the chat only follows one
 * region - Telegram albums require at least 2 items) with the per-region
 * text (exact outage count, most reliable stations) as the caption on the
 * first photo, so the whole thing lands as one post rather than an image
 * followed by a separate message.
 */
async function sendDigest(period) {
  if (!telegramBot.isEnabled()) return;
  const eventKey = period === 'daily' ? 'dailyDigest' : 'hourlyDigest';
  const lastFieldKey = period === 'daily' ? 'lastDailyDigestAt' : 'lastHourlyDigestAt';
  const spanMs = period === 'daily' ? 24 * 3600 * 1000 : 3600 * 1000;
  const sparklineBuckets = period === 'daily' ? 24 : 12;
  const comparisonLabel = period === 'daily' ? 'прошлым суткам' : 'прошлому часу';

  const chats = await TelegramChat.find({ status: 'active', [`events.${eventKey}`]: true }).populate('regions');
  const to = new Date();
  const from = new Date(to.getTime() - spanMs);
  const periodLabel = formatPeriodLabel(period, from, to);

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
      const regionDigests = await Promise.all(
        chat.regions.map((region) =>
          telegramDigestData.buildRegionDigestData(region, { from, to, spanMs, sparklineBuckets })
        )
      );

      const images = await Promise.all(
        regionDigests.map((data) => telegramDigestImage.renderRegionDigestCard(data, { periodLabel, comparisonLabel }))
      );
      const title = period === 'daily' ? '🗓 Дневная сводка' : '🕐 Часовая сводка';
      const caption = buildCaption(title, regionDigests.map(formatRegionDigestText));

      const items = images.map((buffer, i) => (i === 0 ? { buffer, caption } : { buffer }));
      await telegramBot.sendPhotoAlbum(chat, items);

      chat[lastFieldKey] = to;
      await chat.save();
    } catch (err) {
      logger.error(`Telegram digest failed for chat ${chat.chatId}:`, err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

const timeOnlyFmt = new Intl.DateTimeFormat('ru-RU', { timeZone: RU_DATE_TZ, hour: '2-digit', minute: '2-digit' });

function formatDropAlertBlock({ station, predictedAt, availablePct }) {
  return [
    `⚠️ <b>${escapeHtml(station.name || 'АЗС')}</b>`,
    station.address ? escapeHtml(station.address) : null,
    `Вероятность наличия АИ-92 или АИ-95 к ${timeOnlyFmt.format(predictedAt)} падает до ~${availablePct.toFixed(0)}% (по истории для этого времени)`,
  ]
    .filter(Boolean)
    .join('\n');
}

function formatRecoveryAlertBlock({ station, estimatedRecoveryAt }) {
  return [
    `🔄 <b>${escapeHtml(station.name || 'АЗС')}</b>`,
    station.address ? escapeHtml(station.address) : null,
    `Возможно, топливо появится к ${timeOnlyFmt.format(estimatedRecoveryAt)} (оценка по среднему времени восстановления)`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Scans a region for forecast-based heads-up alerts (see
 * telegramPredictiveAlerts.scanRegion) and sends them to every chat that
 * opted into the relevant event type and follows the region (or has the
 * station on its watchlist). Grouped into as few messages as possible per
 * chat, same as notifyRegionChanges. Best-effort - a scan failure must
 * never affect ingestion, callers should still wrap this in try/catch.
 */
async function notifyPredictiveAlerts(region) {
  if (!telegramBot.isEnabled()) return;

  const { dropAlerts, recoveryAlerts } = await telegramPredictiveAlerts.scanRegion(region);
  if (!dropAlerts.length && !recoveryAlerts.length) return;

  const candidateStationIds = [...dropAlerts, ...recoveryAlerts].map((a) => a.station._id);
  const chats = await TelegramChat.find({
    status: 'active',
    $and: [
      { $or: [{ 'events.predictiveDropAlert': true }, { 'events.predictiveRecoveryAlert': true }] },
      { $or: [{ regions: region._id }, { watchlist: { $in: candidateStationIds } }] },
    ],
  });
  if (!chats.length) return;

  await telegramBot.sendToChats(chats, (chat) => {
    const blocks = [];
    if (chat.events.predictiveDropAlert) {
      for (const alert of dropAlerts) {
        if (chatMatchesStation(chat, alert.station)) blocks.push(formatDropAlertBlock(alert));
      }
    }
    if (chat.events.predictiveRecoveryAlert) {
      for (const alert of recoveryAlerts) {
        if (chatMatchesStation(chat, alert.station)) blocks.push(formatRecoveryAlertBlock(alert));
      }
    }
    if (!blocks.length) return [];

    const header = `Прогноз — ${escapeHtml(region.name)}`;
    return chunkMessages(header, blocks);
  });
}

/**
 * Sends one chat's once-a-day promotional post (see
 * TelegramChat.js's `promo` field / telegramPromoScheduler.js, which calls
 * this once it decides a chat is actually due) - rotating marketing copy
 * (telegramPromoContent.js) plus, if this chat already has an
 * alertMapBbox configured, the same map+stats image its fuel alerts use
 * (reusing that setting rather than adding a second "which area" picker
 * just for this). No alertMapBbox means no image, not a failure - the
 * post still goes out as text. Returns whether anything was actually
 * sent, so the scheduler can decide whether to record this as "done for
 * today".
 */
async function sendPromoPost(chat) {
  const text = telegramPromoContent.randomPromoText();

  if (chat.alertMapBbox) {
    try {
      const { minLat, maxLat, minLon, maxLon } = chat.alertMapBbox;
      const stations = await Station.find({
        lat: { $gte: minLat, $lte: maxLat },
        lon: { $gte: minLon, $lte: maxLon },
      })
        .select('lat lon lastStatus lastFuelStatuses')
        .lean();
      const buffer = await telegramAlertMapImage.renderAlertMapImage({
        bbox: chat.alertMapBbox,
        stations,
        visibleStatuses: chat.alertMapStatuses,
      });
      const sent = await telegramBot.sendPhoto(chat, buffer, text);
      if (sent) return true;
      logger.warn(`Telegram promo photo send failed for chat ${chat.chatId}, falling back to text`);
    } catch (err) {
      logger.error(`Telegram promo image failed for chat ${chat.chatId}, falling back to text:`, err.message);
    }
  }

  return telegramBot.sendMessage(chat, text);
}

module.exports = {
  computeTransitions,
  notifyRegionChanges,
  sendDigest,
  notifyPredictiveAlerts,
  sendPromoPost,
  escapeHtml,
  chatMatchesFilters,
};
