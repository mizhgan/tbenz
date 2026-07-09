const { Markup } = require('telegraf');
const TelegramChat = require('../models/TelegramChat');
const Region = require('../models/Region');
const Station = require('../models/Station');
const { escapeHtml } = require('../utils/escapeHtml');

// Same 6 events as the admin panel's TelegramChatForm.vue - kept in sync by
// hand since the frontend and backend don't share a module, same as the
// event keys themselves already live in both TelegramChat.js and there.
const EVENT_OPTIONS = [
  { key: 'stationAvailable', label: 'Топливо появилось на станции' },
  { key: 'stationUnavailable', label: 'Топливо пропало на станции' },
  { key: 'hourlyDigest', label: 'Часовая сводка по районам' },
  { key: 'dailyDigest', label: 'Дневная сводка по районам' },
  { key: 'predictiveDropAlert', label: 'Прогноз: скоро может пропасть' },
  { key: 'predictiveRecoveryAlert', label: 'Прогноз: скоро может появиться' },
];
const EVENT_KEYS = new Set(EVENT_OPTIONS.map((o) => o.key));

// Per-chat "waiting for a text search query" flag for the watchlist's "add a
// station" flow - in-memory only (a restart just means the user has to press
// "Добавить станцию" again), scoped to a single process since the bot runs
// long-polling on exactly one instance at a time.
const awaitingWatchlistSearch = new Set();

function truncate(str, max) {
  const s = String(str ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Populated read model, for rendering menu text/keyboards (needs region and
// station names). Mutations go through loadChatRaw() instead - see there for
// why the two are kept separate.
async function loadChat(chatId) {
  return TelegramChat.findOne({ chatId }).populate('regions').populate('watchlist');
}

// Unpopulated, for mutating regions/watchlist ref arrays - mirrors how
// telegram.controller.js's updateChat does it. Mutating a *populated* array
// (full Region/Station documents) and re-saving risks Mongoose casting
// confusion between "already a document" and "plain id to cast"; staying on
// the raw id representation for writes sidesteps that entirely.
async function loadChatRaw(chatId) {
  return TelegramChat.findOne({ chatId });
}

function statusLine(chat) {
  if (chat.status === 'active') return '🟢 Рассылка включена';
  if (chat.status === 'disabled') return '⏸ Рассылка приостановлена';
  return '⚪️ Рассылка ещё не включена';
}

function toggleActiveLabel(chat) {
  return chat.status === 'active' ? '⏸ Приостановить рассылку' : '🔔 Включить рассылку';
}

function mainMenu(chat) {
  const regionsPart = chat.regions.length
    ? chat.regions.map((r) => escapeHtml(r.name)).join(', ')
    : 'не выбраны';
  const text = [
    '⚙️ <b>Настройки рассылки</b>',
    statusLine(chat),
    '',
    `Районы: ${regionsPart}`,
    `Вотчлист: ${chat.watchlist.length} ст.`,
    '',
    'Выберите, что настроить:',
  ].join('\n');
  const extra = {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback(toggleActiveLabel(chat), 'settings:toggle_active')],
      [Markup.button.callback(`📍 Районы (${chat.regions.length})`, 'settings:regions')],
      [Markup.button.callback('🔔 События', 'settings:events')],
      [Markup.button.callback(`⭐ Вотчлист станций (${chat.watchlist.length})`, 'settings:watchlist')],
      [Markup.button.callback('✖️ Закрыть', 'settings:close')],
    ]),
  };
  return { text, extra };
}

async function regionsMenu(chat) {
  const regions = await Region.find().sort({ name: 1 });
  const selected = new Set(chat.regions.map((r) => String(r._id)));
  const rows = regions.map((r) => [
    Markup.button.callback(
      `${selected.has(String(r._id)) ? '✅' : '⬜️'} ${truncate(r.name, 48)}`,
      `settings:region:${r._id}`
    ),
  ]);
  rows.push([Markup.button.callback('‹ Назад', 'settings:main')]);
  const text = regions.length
    ? '📍 <b>Районы</b>\n\nНажмите на район, чтобы подписаться/отписаться. Уведомления приходят по всем выбранным районам.'
    : '📍 <b>Районы</b>\n\nРайоны ещё не созданы администратором.';
  return { text, extra: { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) } };
}

function eventsMenu(chat) {
  const rows = EVENT_OPTIONS.map(({ key, label }) => [
    Markup.button.callback(`${chat.events[key] ? '✅' : '⬜️'} ${label}`, `settings:event:${key}`),
  ]);
  rows.push([Markup.button.callback('‹ Назад', 'settings:main')]);
  const text = '🔔 <b>События</b>\n\nКакие уведомления присылать.';
  return { text, extra: { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) } };
}

function watchlistMenu(chat) {
  const rows = chat.watchlist.map((s) => [
    Markup.button.callback(`❌ ${truncate(s.name || 'АЗС', 40)}`, `settings:wl_remove:${s._id}`),
  ]);
  rows.push([Markup.button.callback('➕ Добавить станцию', 'settings:wl_add')]);
  rows.push([Markup.button.callback('‹ Назад', 'settings:main')]);
  const text = [
    '⭐ <b>Вотчлист станций</b>',
    '',
    'Станции из вотчлиста уведомляют вас независимо от выбранных районов.',
    chat.watchlist.length ? null : 'Пока пусто.',
  ]
    .filter((line) => line !== null)
    .join('\n');
  return { text, extra: { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) } };
}

function watchlistSearchPrompt() {
  return {
    text: '🔎 Отправьте название или адрес станции для поиска.',
    extra: {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('‹ Отмена', 'settings:watchlist')]]),
    },
  };
}

async function searchStations(query) {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(escaped, 'i');
  return Station.find({ $or: [{ name: pattern }, { address: pattern }] }, { name: 1, address: 1 }).limit(8);
}

function searchResultsMenu(stations) {
  if (!stations.length) {
    return {
      text: '🔎 Ничего не найдено. Попробуйте другой запрос.',
      extra: {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('‹ К вотчлисту', 'settings:watchlist')]]),
      },
    };
  }
  const rows = stations.map((s) => [
    Markup.button.callback(
      truncate(`➕ ${s.name || 'АЗС'} — ${s.address || ''}`.trim(), 60),
      `settings:wl_pick:${s._id}`
    ),
  ]);
  rows.push([Markup.button.callback('‹ К вотчлисту', 'settings:watchlist')]);
  return {
    text: '🔎 Выберите станцию, чтобы добавить в вотчлист:',
    extra: { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) },
  };
}

// Telegram returns a 400 "message is not modified" if the edit would be a
// byte-identical no-op (e.g. a double-tap on the same button before the
// first edit lands) - harmless, nothing else to do about it.
async function safeEditMessageText(ctx, text, extra) {
  try {
    await ctx.editMessageText(text, extra);
  } catch (err) {
    if (!/message is not modified/i.test(err.description || err.message || '')) throw err;
  }
}

/**
 * Wires up the self-service settings menu (/settings command + inline
 * keyboards) for private chats - lets a user who messaged the bot directly
 * configure their own digest/alert subscription without an admin touching
 * the web panel. Deliberately scoped to `chat.type === 'private'`: groups
 * stay admin-managed (anyone can add the bot to a group, so letting any
 * group member reconfigure notifications for the whole group would be a
 * different, much less contained, trust boundary than one person managing
 * their own personal chat).
 *
 * Must be called before the catch-all `bot.on('message', ...)` handler in
 * telegramBot.js is registered - Telegraf runs `.on()` handlers in
 * registration order for a given update, and this module's `bot.on('text',
 * ...)` handler (for the watchlist search flow) needs first refusal so it
 * can intercept search-query text before the catch-all's generic "register
 * unknown chat" logic runs. It always calls `next()` when it doesn't apply,
 * so unrelated messages still reach that catch-all normally.
 */
function registerSettingsMenu(bot, { upsertChatFromCtx }) {
  async function openMain(ctx, chat, { fresh } = {}) {
    const { text, extra } = mainMenu(chat);
    if (fresh) return ctx.reply(text, extra);
    return safeEditMessageText(ctx, text, extra);
  }

  bot.command('settings', async (ctx) => {
    if (ctx.chat.type !== 'private') {
      await ctx.reply(
        'Самостоятельная настройка через меню доступна только в личных сообщениях боту. Групповые чаты настраивает администратор в веб-панели.'
      );
      return;
    }
    await upsertChatFromCtx(ctx);
    const chat = await loadChat(String(ctx.chat.id));
    await openMain(ctx, chat, { fresh: true });
  });

  bot.on('callback_query', async (ctx, next) => {
    const data = ctx.callbackQuery.data || '';
    if (!data.startsWith('settings:')) return next();
    if (ctx.chat?.type !== 'private') {
      await ctx.answerCbQuery('Доступно только в личных сообщениях');
      return;
    }

    const chatIdStr = String(ctx.chat.id);
    awaitingWatchlistSearch.delete(chatIdStr);
    await ctx.answerCbQuery();

    const action = data.slice('settings:'.length);

    if (action === 'main') {
      const chat = await loadChat(chatIdStr);
      if (!chat) return;
      return openMain(ctx, chat);
    }

    if (action === 'toggle_active') {
      const raw = await loadChatRaw(chatIdStr);
      if (!raw) return;
      raw.status = raw.status === 'active' ? 'disabled' : 'active';
      await raw.save();
      const chat = await loadChat(chatIdStr);
      return openMain(ctx, chat);
    }

    if (action === 'regions') {
      const chat = await loadChat(chatIdStr);
      if (!chat) return;
      const { text, extra } = await regionsMenu(chat);
      return safeEditMessageText(ctx, text, extra);
    }

    if (action.startsWith('region:')) {
      const regionId = action.slice('region:'.length);
      const raw = await loadChatRaw(chatIdStr);
      if (!raw) return;
      const idx = raw.regions.findIndex((r) => String(r) === regionId);
      if (idx === -1) raw.regions.push(regionId);
      else raw.regions.splice(idx, 1);
      await raw.save();
      const chat = await loadChat(chatIdStr);
      const { text, extra } = await regionsMenu(chat);
      return safeEditMessageText(ctx, text, extra);
    }

    if (action === 'events') {
      const chat = await loadChat(chatIdStr);
      if (!chat) return;
      const { text, extra } = eventsMenu(chat);
      return safeEditMessageText(ctx, text, extra);
    }

    if (action.startsWith('event:')) {
      const key = action.slice('event:'.length);
      const raw = await loadChatRaw(chatIdStr);
      if (!raw) return;
      if (EVENT_KEYS.has(key)) {
        raw.events[key] = !raw.events[key];
        await raw.save();
      }
      const { text, extra } = eventsMenu(raw);
      return safeEditMessageText(ctx, text, extra);
    }

    if (action === 'watchlist') {
      const chat = await loadChat(chatIdStr);
      if (!chat) return;
      const { text, extra } = watchlistMenu(chat);
      return safeEditMessageText(ctx, text, extra);
    }

    if (action.startsWith('wl_remove:')) {
      const stationId = action.slice('wl_remove:'.length);
      const raw = await loadChatRaw(chatIdStr);
      if (!raw) return;
      raw.watchlist = raw.watchlist.filter((s) => String(s) !== stationId);
      await raw.save();
      const chat = await loadChat(chatIdStr);
      const { text, extra } = watchlistMenu(chat);
      return safeEditMessageText(ctx, text, extra);
    }

    if (action === 'wl_add') {
      awaitingWatchlistSearch.add(chatIdStr);
      const { text, extra } = watchlistSearchPrompt();
      return safeEditMessageText(ctx, text, extra);
    }

    if (action.startsWith('wl_pick:')) {
      const stationId = action.slice('wl_pick:'.length);
      const station = await Station.findById(stationId, { name: 1, address: 1 });
      if (station) {
        const raw = await loadChatRaw(chatIdStr);
        if (raw && !raw.watchlist.some((s) => String(s) === stationId)) {
          raw.watchlist.push(station._id);
          await raw.save();
        }
      }
      const text = station
        ? `✅ Добавлено в вотчлист: <b>${escapeHtml(station.name || 'АЗС')}</b>`
        : 'Станция не найдена (возможно, уже удалена).';
      return safeEditMessageText(ctx, text, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('‹ К вотчлисту', 'settings:watchlist')]]),
      });
    }

    if (action === 'close') {
      return safeEditMessageText(ctx, 'Настройки закрыты. Наберите /settings, чтобы открыть снова.', {});
    }
  });

  bot.on('text', async (ctx, next) => {
    const chatIdStr = String(ctx.chat.id);
    if (ctx.chat.type !== 'private' || !awaitingWatchlistSearch.has(chatIdStr)) {
      return next();
    }
    const query = ctx.message.text.trim();
    if (!query) return next();

    const stations = await searchStations(query);
    const { text, extra } = searchResultsMenu(stations);
    await ctx.reply(text, extra);
    // Flag stays set so the user can immediately try another search term
    // without pressing "Добавить станцию" again - it only clears once they
    // pick a result or navigate away via any other menu button (see the
    // callback_query handler above).
  });
}

module.exports = { registerSettingsMenu };
