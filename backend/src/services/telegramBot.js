const { Telegraf } = require('telegraf');
const { telegramBotToken } = require('../config/env');
const TelegramChat = require('../models/TelegramChat');
const logger = require('../utils/logger');

let bot = null;

function isEnabled() {
  return Boolean(telegramBotToken);
}

function chatTitleFrom(chat) {
  return (
    chat.title ||
    [chat.first_name, chat.last_name].filter(Boolean).join(' ') ||
    chat.username ||
    String(chat.id)
  );
}

// Registers a chat the first time the bot sees it, as "pending" - it stays
// invisible to notification logic until an admin activates it from the
// panel. Anyone can add the bot anywhere; that alone never subscribes them
// to anything, it just shows up in the admin's "new chats" list.
async function upsertChatFromCtx(ctx) {
  const chat = ctx.chat;
  const chatId = String(chat.id);
  const title = chatTitleFrom(chat);

  const existing = await TelegramChat.findOne({ chatId });
  if (existing) {
    if (existing.title !== title) {
      existing.title = title;
      await existing.save();
    }
    return existing;
  }

  const created = await TelegramChat.create({ chatId, title, type: chat.type, status: 'pending' });
  logger.info(`Telegram: new chat registered as pending (${chat.type} ${chatId}: "${title}")`);
  return created;
}

let launchError = null;

async function start() {
  if (!isEnabled()) {
    logger.info('Telegram bot disabled (TELEGRAM_BOT_TOKEN not set)');
    return;
  }

  bot = new Telegraf(telegramBotToken);

  bot.start(async (ctx) => {
    const chatDoc = await upsertChatFromCtx(ctx);
    await ctx.reply(
      chatDoc.status === 'active'
        ? 'Этот чат уже настроен администратором.'
        : `Чат зарегистрирован (ID: ${chatDoc.chatId}). Дождитесь настройки в админ-панели «Топливо».`
    );
  });

  // Groups rarely get an explicit /start (e.g. the bot is just silently
  // added) - register on any first message we see from an unknown chat too.
  bot.on('message', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const exists = await TelegramChat.exists({ chatId });
    if (!exists) {
      const chatDoc = await upsertChatFromCtx(ctx);
      await ctx.reply(`Чат зарегистрирован (ID: ${chatDoc.chatId}). Дождитесь настройки в админ-панели «Топливо».`);
    }
  });

  bot.catch((err) => {
    logger.error('Telegram bot error:', err.message);
  });

  // bot.launch() does not resolve until the bot stops - for long polling it
  // internally runs the receive loop for the entire lifetime of the process.
  // It must never be awaited here: doing so would block the rest of startup
  // (including app.listen()) forever, taking the whole backend down with it.
  launchError = null;
  bot
    .launch()
    .catch((err) => {
      logger.error('Telegram bot failed to launch:', err.message);
      launchError = err.message;
      bot = null;
    });
  logger.info('Telegram bot launching (long polling)...');
}

function stop() {
  if (bot) bot.stop('SIGTERM');
}

async function getStatus() {
  if (!isEnabled()) return { enabled: false, running: false, username: null };
  if (!bot) return { enabled: true, running: false, username: null, error: launchError };
  if (!bot.botInfo) return { enabled: true, running: false, username: null };
  return { enabled: true, running: true, username: bot.botInfo.username };
}

// Swallows per-chat errors so one bad chat (blocked/kicked the bot) never
// stops the rest of a batch; disables the chat on a definitive 403 so we
// stop retrying it forever.
async function sendMessage(chatDoc, text) {
  if (!bot) return false;
  try {
    await bot.telegram.sendMessage(chatDoc.chatId, text, { parse_mode: 'HTML' });
    return true;
  } catch (err) {
    logger.warn(`Telegram: failed to send to chat ${chatDoc.chatId}: ${err.message}`);
    if (err.response?.error_code === 403) {
      chatDoc.status = 'disabled';
      await chatDoc.save();
    }
    return false;
  }
}

// Sequential dispatch with a small delay between sends - keeps well under
// Telegram's ~30 msg/sec global rate limit without needing a real queue for
// what's expected to be, at most, a handful of chats per event.
async function sendToChats(chatDocs, textFn) {
  for (const chatDoc of chatDocs) {
    await sendMessage(chatDoc, textFn(chatDoc));
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

module.exports = { start, stop, isEnabled, getStatus, sendMessage, sendToChats };
