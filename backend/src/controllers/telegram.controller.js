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
    alertMapBbox: chat.alertMapBbox
      ? {
          minLat: chat.alertMapBbox.minLat,
          maxLat: chat.alertMapBbox.maxLat,
          minLon: chat.alertMapBbox.minLon,
          maxLon: chat.alertMapBbox.maxLon,
        }
      : null,
    alertMapStatuses: chat.alertMapStatuses,
    promo: { enabled: chat.promo.enabled, time: chat.promo.time },
    lastPromoPostAt: chat.lastPromoPostAt,
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
  if (body.alertMapBbox !== undefined) {
    if (body.alertMapBbox === null) {
      out.alertMapBbox = null;
    } else {
      const { minLat, maxLat, minLon, maxLon } = body.alertMapBbox || {};
      const coords = [minLat, maxLat, minLon, maxLon];
      if (typeof body.alertMapBbox !== 'object' || coords.some((c) => !Number.isFinite(c))) {
        throw new HttpError(400, 'alertMapBbox must be null or {minLat, maxLat, minLon, maxLon} numbers');
      }
      if (minLat >= maxLat || minLon >= maxLon) {
        throw new HttpError(400, 'alertMapBbox: min must be less than max for both lat and lon');
      }
      out.alertMapBbox = { minLat, maxLat, minLon, maxLon };
    }
  }
  if (body.alertMapStatuses !== undefined) {
    if (!Array.isArray(body.alertMapStatuses) || body.alertMapStatuses.some((s) => !TelegramChat.AVAILABILITY_STATUSES.includes(s))) {
      throw new HttpError(400, `alertMapStatuses must be an array of: ${TelegramChat.AVAILABILITY_STATUSES.join(', ')}`);
    }
    out.alertMapStatuses = body.alertMapStatuses;
  }
  if (body.promo !== undefined) {
    if (typeof body.promo !== 'object' || body.promo === null) {
      throw new HttpError(400, 'promo must be an object');
    }
    out.promo = {};
    if (body.promo.enabled !== undefined) out.promo.enabled = Boolean(body.promo.enabled);
    if (body.promo.time !== undefined) {
      if (typeof body.promo.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.promo.time)) {
        throw new HttpError(400, 'promo.time must be "HH:mm"');
      }
      out.promo.time = body.promo.time;
    }
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
  if (data.promo) {
    chat.promo = { ...chat.promo.toObject(), ...data.promo };
    delete data.promo;
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
