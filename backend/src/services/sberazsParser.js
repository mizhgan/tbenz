/**
 * Parsing of the sberazs.ru station payload.
 *
 * Verified against a real sample response (bbox-filtered, confirmed
 * server-side - see sberazsClient.js) - a wrapper object, not a flat array:
 *
 *   { "version": "...", "stationCount": 122, "hiddenStationCount": 0,
 *     "lastSuccessfulPullAt": "...", "lastErrorPresent": false,
 *     "stations": [{ "id": "70000001032870486", "branchId": "...",
 *       "name": "АГЗС", "address": "...",
 *       "location": { "lat": 58.33, "lon": 48.41, "address": "..." },
 *       "availabilityStatus": "unknown", "lastPaymentAt": "2026-07-16T10:49:56+03:00",
 *       "updatedAt": "...", "fuels": [{ "type": "propane" }],
 *       "externalIds": { "twoGisBranchId": "70000001032870486" },
 *       "crowdState": { "status": "insufficient_data", "confidence": 0,
 *         "positiveVotes": 0, "negativeVotes": 0 } }, ...] }
 *
 * `lastPaymentAt` (station-level, not per-fuel) only appears on stations
 * that have ever recorded a card payment - ~86/110 in one real region -
 * and, verified live, genuinely varies per station (unlike `updatedAt`
 * right next to it, which is identical across every station in a poll - a
 * whole-feed batch stamp, not per-station freshness). The one real
 * source-reported transaction time this source has.
 *
 * Structural differences from tbank's payload (stationParser.js) that shape
 * everything downstream:
 *   - Status was originally only per-STATION, like gdebenz: `fuels` just
 *     listed which types a station carries at all, with no per-type
 *     availability - mergeStatusService.js projects that one station-level
 *     status onto every listed fuel type, same as it does for gdebenz (see
 *     mergeStationFuelStatuses). Some stations' `fuels` entries still look
 *     like this today (bare `{"type": "ai92"}`, no status of their own).
 *   - Other stations now carry genuine per-fuel-type data instead: each
 *     `fuels[]` entry can have its own `availabilityStatus` (and `available`
 *     boolean/`limitLiters`), e.g. `{"type": "ai92", "available": true,
 *     "availabilityStatus": "available", "limitLiters": 30}` next to
 *     `{"type": "diesel", "available": false, "availabilityStatus":
 *     "stale"}` on the very same station - real evidence this source can
 *     confirm or abstain on per fuel type, not just as one blanket claim
 *     for the whole station. `parseFuels` below keeps both: `fuelTypes`
 *     (every listed type, for the old station-level projection fallback)
 *     and `fuelStatuses` (only entries that actually carry their own
 *     `availabilityStatus` key - even "unknown" counts, since that's sberazs
 *     explicitly saying it has no per-fuel opinion on that type, which
 *     should NOT fall back to the station-level status being projected onto
 *     it). See mergeStatusService.mergeStationFuelStatuses for how a
 *     fuelStatuses entry takes priority over projection when present.
 *   - Across the entire dataset seen so far, `availabilityStatus` (station-
 *     level or per-fuel) only ever takes three values - available/stale/
 *     unknown - with NO equivalent of a confirmed "not available" reading.
 *     This source can therefore only ever confirm availability or abstain
 *     in the merge; it can never independently contradict tbank the way
 *     gdebenz's "no" can. `stale` (seen recently but no fresh payment
 *     confirming it since) maps to maybe_available - weaker evidence than a
 *     fresh confirmation, but still more than "no data at all".
 *   - `crowdState` (positiveVotes/negativeVotes/confidence) is a second,
 *     independent crowd-vote signal bundled in the same payload - currently
 *     `insufficient_data`/all-zero for every station seen, so not mapped
 *     into `status`/`conflict` yet (see SberazsStation.js's doc comment);
 *     preserved as-is in `raw` so nothing is lost once it starts populating.
 */

const { normalizeFuelType } = require('../utils/fuelTypeNormalizer');

const STATUS_MAP = {
  available: 'available',
  stale: 'maybe_available',
  unknown: 'no_data',
};

function mapStatus(rawStatus) {
  if (rawStatus === null || rawStatus === undefined) return 'no_data';
  return STATUS_MAP[rawStatus] || 'no_data';
}

// sberazs names octane ratings "aiNN"; the app's own vocabulary (see
// stationParser.js/fuelTypeLabel) is the bare number ("92", "95", ...) -
// propane/methane pass through unchanged, already displayed as-is by the
// frontend's generic fuelTypeLabel fallback. "diesel" additionally goes
// through the shared fuel type normalizer (see utils/fuelTypeNormalizer.js)
// since gdebenz names the exact same fuel "ДТ" - left as two different
// strings, the merge/display layer would treat them as unrelated types.
const FUEL_TYPE_MAP = {
  ai92: '92',
  ai95: '95',
  ai98: '98',
  ai100: '100',
  // Some pumps sell AI-98/AI-100 interchangeably through one nozzle - sberazs
  // reports that as one combined type rather than two separate readings.
  // Folded onto "100" (the higher grade) rather than kept as its own type,
  // so it merges with tbank/gdebenz's plain "100" instead of showing up as a
  // third, unrelated fuel type next to it.
  ai98_100: '100',
};

function mapFuelType(rawType) {
  return normalizeFuelType(FUEL_TYPE_MAP[rawType] || rawType);
}

function parseFuels(fuels) {
  if (!Array.isArray(fuels)) return [];
  return fuels.map((f) => mapFuelType(f?.type)).filter(Boolean);
}

// Only entries that actually carry their own `availabilityStatus` key -
// bare `{"type": "ai92"}` (no key at all) has nothing to report and is
// left out, not defaulted to "unknown", so the merge can tell "sberazs said
// it doesn't know about this fuel type" (should suppress the old
// station-level projection) apart from "sberazs hasn't upgraded this
// station's data yet" (should still fall back to it) - see this file's own
// doc comment and mergeStatusService.mergeStationFuelStatuses.
function parseFuelStatuses(fuels) {
  if (!Array.isArray(fuels)) return [];
  return fuels
    .filter((f) => f && typeof f === 'object' && f.availabilityStatus !== undefined)
    .map((f) => ({ fuelType: mapFuelType(f.type), status: mapStatus(f.availabilityStatus) }))
    .filter((f) => f.fuelType);
}

function extractStationsArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  return Array.isArray(payload.stations) ? payload.stations : [];
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseStation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const lat = Number(raw.location?.lat);
  const lon = Number(raw.location?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const externalId = raw.id ?? raw.branchId ?? raw.externalIds?.twoGisBranchId;
  if (externalId === undefined || externalId === null) return null;

  return {
    externalId: String(externalId),
    name: raw.name || null,
    brand: null, // sberazs has no separate brand field - often embedded in `name` (e.g. "Лукойл, АЗС")
    address: raw.location?.address || raw.address || null,
    lat,
    lon,
    status: mapStatus(raw.availabilityStatus),
    fuelTypes: parseFuels(raw.fuels),
    fuelStatuses: parseFuelStatuses(raw.fuels),
    // Station-level (not per-fuel-type, unlike tbank/alfabank) - a genuine
    // last-card-payment timestamp, present for stations that have ever seen
    // one and absent otherwise (not every station has it - see this file's
    // own live-verified coverage: ~86/110 in one real region). Distinct from
    // `raw.updatedAt` right below it in the payload, which is identical
    // across every single station in a poll (a whole-feed batch stamp, not
    // per-station freshness) - confirmed live before wiring this in, so that
    // mistake wasn't repeated here.
    lastTransactionAt: parseDate(raw.lastPaymentAt),
    conflict: null,
    raw,
  };
}

module.exports = { parseStation, extractStationsArray, mapStatus, mapFuelType };
