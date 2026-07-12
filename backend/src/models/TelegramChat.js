const { Schema, model } = require('mongoose');

const STATUSES = ['pending', 'active', 'disabled'];
const CHAT_TYPES = ['private', 'group', 'supergroup', 'channel'];
// Same 4 statuses everywhere else in the app (fuelStatus.js's STATUS_META
// on the frontend, mergeStatusService.js's vocabulary on the backend).
const AVAILABILITY_STATUSES = ['available', 'maybe_available', 'not_available', 'no_data'];

const telegramChatSchema = new Schema(
  {
    // Telegram's own chat id (negative for groups/supergroups). Stored as a
    // string since it can exceed Number.MAX_SAFE_INTEGER for some chat ids.
    chatId: { type: String, required: true, unique: true },
    title: { type: String, default: '' },
    type: { type: String, enum: CHAT_TYPES, required: true },
    // A chat is created as "pending" the moment the bot first sees it (added
    // to a group, or messaged directly) - it receives nothing until an admin
    // deliberately reviews and activates it from the admin panel. This is
    // the actual access-control boundary: anyone can add the bot anywhere,
    // but that alone never subscribes them to anything.
    status: { type: String, enum: STATUSES, default: 'pending' },
    linkedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    regions: [{ type: Schema.Types.ObjectId, ref: 'Region' }],
    events: {
      stationAvailable: { type: Boolean, default: true },
      stationUnavailable: { type: Boolean, default: true },
      hourlyDigest: { type: Boolean, default: false },
      dailyDigest: { type: Boolean, default: false },
      // Opt-in forecast-based heads-up, not tied to an actual status change
      // yet: "this station's history suggests it'll likely run out soon" /
      // "...likely come back soon". Off by default since it's a prediction,
      // not an observed fact, and the base transition events already cover
      // the confirmed case.
      predictiveDropAlert: { type: Boolean, default: false },
      predictiveRecoveryAlert: { type: Boolean, default: false },
    },
    // Empty array means "no filter" (matches everything) for both.
    fuelTypes: [{ type: String }],
    brands: [{ type: String }],
    // Stations always trigger stationAvailable/stationUnavailable for this
    // chat regardless of `regions`/`fuelTypes`/`brands`, for "just tell me
    // about this one specific station" use cases.
    watchlist: [{ type: Schema.Types.ObjectId, ref: 'Station' }],

    lastHourlyDigestAt: { type: Date, default: null },
    lastDailyDigestAt: { type: Date, default: null },

    // Optional, admin-picked sub-area (RegionMapPicker.vue, reused in
    // TelegramChatForm.vue) for the map snapshot attached to
    // stationAvailable/stationUnavailable alerts (see
    // telegramNotifier.notifyRegionChanges / telegramAlertMapImage.js).
    // Deliberately NOT the followed region's own (usually much larger)
    // bbox - rendering every station across a whole region onto one small
    // image makes markers too small/cramped to read at a glance; an admin
    // picking a smaller, specific area keeps the image legible. null (the
    // default) means no image is attached at all for this chat.
    alertMapBbox: {
      type: new Schema(
        {
          minLat: { type: Number, required: true },
          maxLat: { type: Number, required: true },
          minLon: { type: Number, required: true },
          maxLon: { type: Number, required: true },
        },
        { _id: false }
      ),
      default: null,
    },
    // Which statuses get a dot drawn on the alert map image - NOT the same
    // as an "empty means no filter" array elsewhere on this schema (empty
    // here would mean "show nothing", a real and sometimes-intended state,
    // not "show everything"), so this always holds an explicit list.
    // Defaults to all four (identical to the map having no filter at all)
    // so an existing chat with alertMapBbox already set keeps seeing
    // exactly what it saw before this field existed - narrowing it (e.g.
    // dropping not_available, which tends to dominate the map and drown
    // out the few available/maybe_available stations worth noticing) is
    // an explicit admin choice, not a new default behavior. The stats
    // strip under the map is unaffected by this - it always reflects
    // every station in the picked area, not just the ones drawn as dots
    // (see telegramAlertMapImage.js's doc comment on why).
    alertMapStatuses: { type: [String], default: () => [...AVAILABILITY_STATUSES] },
  },
  { timestamps: true }
);

const TelegramChat = model('TelegramChat', telegramChatSchema);
TelegramChat.STATUSES = STATUSES;
TelegramChat.CHAT_TYPES = CHAT_TYPES;
TelegramChat.AVAILABILITY_STATUSES = AVAILABILITY_STATUSES;

module.exports = TelegramChat;
