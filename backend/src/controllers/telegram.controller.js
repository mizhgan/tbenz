const asyncHandler = require('../utils/asyncHandler');
const { HttpError } = require('../middleware/errorHandler');
const TelegramChat = require('../models/TelegramChat');
const telegramBot = require('../services/telegramBot');

function serializeChat(chat) {
  return {
    id: chat._id,
    chatId: chat.chatId,
    title: chat.title,
    type: chat.type,
    status: chat.status,
    regions: chat.regions.map((r) =>
      r && r.name !== undefined ? { id: r._id, name: r.name } : { id: r, name: null }
    ),
    events: chat.events,
    fuelTypes: chat.fuelTypes,
    brands: chat.brands,
    watchlist: chat.watchlist.map((s) =>
      s && s.name !== undefined ? { id: s._id, name: s.name, address: s.address } : { id: s, name: null }
    ),
    lastHourlyDigestAt: chat.lastHourlyDigestAt,
    lastDailyDigestAt: chat.lastDailyDigestAt,
    createdAt: chat.createdAt,
  };
}

const getStatus = asyncHandler(async (req, res) => {
  const status = await telegramBot.getStatus();
  res.json(status);
});

const listChats = asyncHandler(async (req, res) => {
  const chats = await TelegramChat.find()
    .sort({ createdAt: 1 })
    .populate('regions', 'name')
    .populate('watchlist', 'name address');
  res.json(chats.map(serializeChat));
});

function validateUpdate(body) {
  const out = {};

  if (body.status !== undefined) {
    if (!TelegramChat.STATUSES.includes(body.status)) {
      throw new HttpError(400, `status must be one of: ${TelegramChat.STATUSES.join(', ')}`);
    }
    out.status = body.status;
  }
  if (body.regions !== undefined) {
    if (!Array.isArray(body.regions)) throw new HttpError(400, 'regions must be an array');
    out.regions = body.regions;
  }
  if (body.events !== undefined) {
    if (typeof body.events !== 'object' || body.events === null) {
      throw new HttpError(400, 'events must be an object');
    }
    out.events = body.events;
  }
  if (body.fuelTypes !== undefined) {
    if (!Array.isArray(body.fuelTypes)) throw new HttpError(400, 'fuelTypes must be an array');
    out.fuelTypes = body.fuelTypes.map(String);
  }
  if (body.brands !== undefined) {
    if (!Array.isArray(body.brands)) throw new HttpError(400, 'brands must be an array');
    out.brands = body.brands.map(String);
  }
  if (body.watchlist !== undefined) {
    if (!Array.isArray(body.watchlist)) throw new HttpError(400, 'watchlist must be an array');
    out.watchlist = body.watchlist;
  }

  return out;
}

const updateChat = asyncHandler(async (req, res) => {
  const chat = await TelegramChat.findById(req.params.id);
  if (!chat) throw new HttpError(404, 'Chat not found');

  const data = validateUpdate(req.body || {});
  if (data.events) {
    chat.events = { ...chat.events.toObject(), ...data.events };
    delete data.events;
  }
  Object.assign(chat, data);
  await chat.save();
  res.json(serializeChat(chat));
});

const deleteChat = asyncHandler(async (req, res) => {
  const chat = await TelegramChat.findById(req.params.id);
  if (!chat) throw new HttpError(404, 'Chat not found');
  await chat.deleteOne();
  res.status(204).end();
});

const testMessage = asyncHandler(async (req, res) => {
  const chat = await TelegramChat.findById(req.params.id);
  if (!chat) throw new HttpError(404, 'Chat not found');
  if (!telegramBot.isEnabled()) throw new HttpError(400, 'Telegram bot is not configured (TELEGRAM_BOT_TOKEN unset)');

  const ok = await telegramBot.sendMessage(chat, '✅ Тестовое сообщение из админки «Топливо».');
  if (!ok) throw new HttpError(502, 'Не удалось отправить сообщение (см. логи бэкенда)');
  res.json({ ok: true });
});

module.exports = { getStatus, listChats, updateChat, deleteChat, testMessage };
