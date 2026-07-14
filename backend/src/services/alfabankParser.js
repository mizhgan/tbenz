/**
 * Parsing of alfabank.ru's public azs-stations payload
 * (GET /api/v1/azs-stations/public/stations - no bbox param, returns every
 * station in Russia in one response; see alfabankClient.js for how that's
 * fetched and bbox-filtered).
 *
 * Verified against a real sample response - a flat array, no wrapper object:
 *
 *   [{ "station_id": "000af3b0-135e-4dc3-8029-a5474143b425",
 *      "brand": { "name": "Газпромнефть" },
 *      "address": { "fullname": "ул. Березовский Тракт, 2, ...",
 *        "location": { "latitude": 56.898526, "longitude": 60.76648 } },
 *      "fuels": [
 *        { "category": "AI92", "status": "available",
 *          "last_transaction_at": "2026-07-12T09:18:38.000Z", "price": "64.50" },
 *        { "category": "AI98_100", "status": "probably_unavailable",
 *          "last_transaction_at": "2026-06-27T09:51:32.000Z", "price": null }, ...
 *      ] }, ...]
 *
 * Unlike gdebenz/sberazs (a coarse station-level status, projected onto
 * whichever fuel types are listed), this source reports genuine per-fuel-type
 * status for essentially every station on every poll - four categories,
 * transaction-derived, the same underlying signal as tbank's own
 * statusByFuelType. There is no station-level status field in the payload at
 * all, so `status` below is derived from this source's own four fuel-type
 * readings via the same weighted-vote resolver mergeStatusService.js uses to
 * combine *several sources'* readings - applied here to just this one
 * source's own readings, at equal weight, as the closest single-source
 * analog of "what would this source say about the station overall".
 *
 * `last_transaction_at` recency check: verified live against a real region's
 * worth of data (Kirov, 77 stations) that "available"/"probably_unavailable"/
 * "unavailable" are genuinely transaction-recency-derived. "available" and
 * the two negative statuses deliberately use different staleness bars -
 * see AVAILABLE_STALE_AFTER_MS/STALE_AFTER_MS below for the current figures
 * and reasoning - because they carry different risk if trusted stale:
 *  - "probably_unavailable" ranges up to 27 days stale (median ~6 days,
 *    never under 17 hours) - alfabank keeps asserting this weak-negative
 *    hedge indefinitely rather than ever giving up and reporting "unknown"
 *    once a pump's own transaction history goes cold. A three-week-old
 *    "probably_unavailable" at full weight would let stale noise quietly
 *    outvote a fresh tbank/gdebenz reading (see combineTwo's doc comment on
 *    why this app prefers admitting "we don't know" over guessing) - kept
 *    at the same 12h bar "unavailable" gets, not tightened, since a stale
 *    negative merely under-reports (worst case: a driver checks elsewhere
 *    for fuel that was actually there).
 *  - "available" over-reports if trusted stale (worst case: a driver drives
 *    to a station banking on fuel that's been gone for hours) - the worse
 *    failure for this app's purpose, and the one that prompted tightening
 *    this bar specifically after a live report of exactly that: a station
 *    with zero tbank/gdebenz/sberazs coverage read "available" off a
 *    same-day but hours-stale alfabank purchase alone, with nothing to
 *    check it against (resolveVotes reduces to a single vote when it's the
 *    only source with any signal at all for that fuel type - not a bug in
 *    the vote resolver itself, just this source's own claim being weaker
 *    evidence than its weight assumed once several hours old).
 * Either way, once stale, mapStatus downgrades the reading to no_data,
 * dropping it out of the merge vote entirely (resolveVotes skips readings
 * whose status isn't a recognized available/maybe_available/not_available).
 * "closed" is deliberately exempt from all of this - confirmed live it's a
 * station-level flag applied uniformly across all 4 categories at once (not
 * a per-fuel staleness artifact) for stations alfabank considers shut,
 * frequently even with no last_transaction_at ever recorded for that pump;
 * "unknown" already maps to no_data regardless.
 */
const { normalizeFuelType } = require('../utils/fuelTypeNormalizer');
const { resolveVotes } = require('./mergeStatusService');

const STATUS_MAP = {
  available: 'available',
  // A soft, transaction-recency-based inference (no purchase seen in a
  // while), not a confirmed "no fuel" - same weak-negative-evidence role as
  // sberazs's "stale" (see sberazsParser.js), not "unavailable" outright.
  probably_unavailable: 'maybe_available',
  unavailable: 'not_available',
  // The pump/station itself is closed - functionally the same as "no fuel
  // for sale here right now" for a driver's purposes.
  closed: 'not_available',
  unknown: 'no_data',
};

// See this file's doc comment above for why exactly these three (not
// "closed"/"unknown") get staleness-checked at all, and for the 12h figure
// itself - a deliberate compromise, not a "never touches real data" safe
// margin the way the originally-considered 7 days was.
//
// "available" gets its own, much stricter bar (4h, not 12h) - confirmed
// live this source is sometimes literally the only vote a station gets for
// a given fuel type (no tbank/gdebenz/sberazs coverage there at all), so
// resolveVotes' weighted average reduces to just this one reading with
// nothing to check it against. A stale "unavailable"/"probably_unavailable"
// merely under-reports (worst case, a driver checks elsewhere for fuel
// that was actually there) - a stale solo "available" over-reports (worst
// case, a driver drives to a station banking on fuel that's been gone for
// hours), which is the worse failure for this app's whole purpose. Verified
// live (Кировская область, 87 raw "available" readings) that this cutoff
// is a real, deliberate trade: only ~21% of them stay trusted, down from
// ~49% at 12h - accepted anyway, since the alternative was this source
// single-handedly asserting "available" off a same-day-but-hours-stale
// purchase with zero corroboration.
const RECENCY_DEPENDENT_STATUSES = new Set(['available', 'probably_unavailable', 'unavailable']);
const STALE_AFTER_MS = 12 * 60 * 60 * 1000;
const AVAILABLE_STALE_AFTER_MS = 4 * 60 * 60 * 1000;

function isStale(rawStatus, lastTransactionAt) {
  if (!lastTransactionAt) return true;
  const date = new Date(lastTransactionAt);
  if (Number.isNaN(date.getTime())) return true;
  const staleAfterMs = rawStatus === 'available' ? AVAILABLE_STALE_AFTER_MS : STALE_AFTER_MS;
  return Date.now() - date.getTime() > staleAfterMs;
}

function mapStatus(rawStatus, lastTransactionAt) {
  if (rawStatus === null || rawStatus === undefined) return 'no_data';
  if (RECENCY_DEPENDENT_STATUSES.has(rawStatus) && isStale(rawStatus, lastTransactionAt)) return 'no_data';
  return STATUS_MAP[rawStatus] || 'no_data';
}

// alfabank names octane ratings "AI92"/"AI95"/"AI98_100"; the app's own
// vocabulary (see stationParser.js/fuelTypeLabel) is the bare number.
// "DIESEL" needs no entry here - it already normalizes to "ДТ" via the
// shared alias table (utils/fuelTypeNormalizer.js), same as sberazs's own
// "diesel" spelling.
const FUEL_TYPE_MAP = {
  AI92: '92',
  AI95: '95',
  AI98_100: '100',
};

function mapFuelType(rawType) {
  return normalizeFuelType(FUEL_TYPE_MAP[rawType] || rawType);
}

function parseTransactionDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseFuelStatuses(fuels) {
  if (!Array.isArray(fuels)) return [];
  return fuels
    .map((f) => ({
      fuelType: mapFuelType(f?.category),
      status: mapStatus(f?.status, f?.last_transaction_at),
      // Kept as-is even for a status just downgraded to no_data for being
      // stale (see mapStatus) - "not trusted as current" and "we don't know
      // when this was last seen" are worth showing separately (see
      // AlfabankStation.js's doc comment on this field).
      lastTransactionAt: parseTransactionDate(f?.last_transaction_at),
    }))
    .filter((f) => f.fuelType);
}

function deriveOverallStatus(fuelStatuses) {
  if (!fuelStatuses.length) return 'no_data';
  return resolveVotes(fuelStatuses.map((f) => ({ status: f.status, weight: 1 }))).status;
}

function extractStationsArray(payload) {
  return Array.isArray(payload) ? payload : [];
}

function parseStation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const lat = Number(raw.address?.location?.latitude);
  const lon = Number(raw.address?.location?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const externalId = raw.station_id ? String(raw.station_id) : null;
  if (!externalId) return null;

  const fuelStatuses = parseFuelStatuses(raw.fuels);
  // Mirrors every category this source has *any* reading for (not just
  // currently-available ones, unlike gdebenz's fuels_now) - feeds
  // mergeStationFuelStatuses' allTypes union; fuelStatuses above (not this)
  // is what actually drives this source's per-type vote in that merge.
  const fuelTypes = fuelStatuses.map((f) => f.fuelType);

  return {
    externalId,
    name: null, // alfabank has no separate station name, only brand + address
    brand: raw.brand?.name || null,
    address: raw.address?.fullname || null,
    lat,
    lon,
    status: deriveOverallStatus(fuelStatuses),
    fuelTypes,
    fuelStatuses,
    conflict: null,
    raw,
  };
}

module.exports = { parseStation, extractStationsArray, mapStatus, mapFuelType };
