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
 *       "availabilityStatus": "unknown", "updatedAt": "...",
 *       "fuels": [{ "type": "propane" }],
 *       "externalIds": { "twoGisBranchId": "70000001032870486" },
 *       "crowdState": { "status": "insufficient_data", "confidence": 0,
 *         "positiveVotes": 0, "negativeVotes": 0 } }, ...] }
 *
 * Two structural differences from tbank's payload (stationParser.js) that
 * shape everything downstream:
 *   - Status is per-STATION like gdebenz, not per-fuel-type: `fuels` only
 *     lists which types this station carries at all, not their individual
 *     availability - mergeStatusService.js projects the one station-level
 *     status onto every listed fuel type the same way it already does for
 *     gdebenz (see mergeStationFuelStatuses).
 *   - Across the entire dataset seen so far, `availabilityStatus` only ever
 *     takes three values - available/stale/unknown - with NO equivalent of
 *     a confirmed "not available" reading. This source can therefore only
 *     ever confirm availability or abstain in the merge; it can never
 *     independently contradict tbank the way gdebenz's "no" can. `stale`
 *     (seen recently but no fresh payment confirming it since) maps to
 *     maybe_available - weaker evidence than a fresh confirmation, but
 *     still more than "no data at all".
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

function extractStationsArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  return Array.isArray(payload.stations) ? payload.stations : [];
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
    conflict: null,
    raw,
  };
}

module.exports = { parseStation, extractStationsArray, mapStatus, mapFuelType };
