const TelegramChat = require('../models/TelegramChat');
const telegramBot = require('./telegramBot');
const telegramNotifier = require('./telegramNotifier');
const logger = require('../utils/logger');

// Checked on the same short interval as telegramDigestScheduler - a chat's
// own promo.time (a specific clock time, not a rolling window) is what
// actually determines when it's due, this just controls how promptly a
// newly-passed time gets noticed.
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const RU_DATE_TZ = 'Europe/Moscow';

// Moscow has used a fixed UTC+3 offset with no DST since 2014, so "today's
// scheduled moment" can be built directly from a literal +03:00 offset
// instead of pulling in a timezone-arithmetic library - format "now" as a
// Moscow calendar date, then anchor promo.time ("HH:mm") to that date.
function todaysScheduledMoment(time) {
  const [hh, mm] = time.split(':');
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: RU_DATE_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return new Date(`${ymd}T${hh}:${mm}:00+03:00`);
}

async function tick() {
  if (!telegramBot.isEnabled()) return;

  const chats = await TelegramChat.find({ status: 'active', 'promo.enabled': true });
  const now = new Date();

  for (const chat of chats) {
    try {
      const scheduled = todaysScheduledMoment(chat.promo.time);
      // Not yet time today, or already sent at/after today's scheduled
      // moment (comparing calendar-day-anchored, not "24h since last" -
      // see TelegramChat.js's doc comment on lastPromoPostAt for why).
      if (now < scheduled) continue;
      if (chat.lastPromoPostAt && chat.lastPromoPostAt >= scheduled) continue;

      await telegramNotifier.sendPromoPost(chat);
      chat.lastPromoPostAt = now;
      await chat.save();
    } catch (err) {
      logger.error(`Telegram promo post failed for chat ${chat.chatId}:`, err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

let handle = null;

function start() {
  if (handle) return;
  handle = setInterval(tick, CHECK_INTERVAL_MS);
  tick();
}

function stop() {
  if (handle) {
    clearInterval(handle);
    handle = null;
  }
}

module.exports = { start, stop };
