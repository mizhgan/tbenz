/**
 * Parsing of the gdebenz.ru station payload.
 *
 * Verified against a real sample response - a flat array, no wrapper object:
 *
 *   [{ "osm_id": "usr_uC6G5M38EXo", "name": "Лукойл", "brand": "Лукойл",
 *      "lat": 58.517, "lon": 49.688, "addr": "ул Советская, 2",
 *      "status": "no", "fuels_now": "", "conflict": null }, ...]
 *
 * Two structural differences from tbank's payload (stationParser.js) that
 * shape everything downstream:
 *   - Status is per-STATION, not per-fuel-type: gdebenz has no equivalent of
 *     tbank's statusByFuelType, just one overall `status` plus a flat
 *     `fuels_now` list of types that are currently available (populated only
 *     when the station has fuel at all). mergeStatusService.js is what
 *     reconciles this coarser signal against tbank's finer-grained one.
 *   - `conflict` reflects disagreement between gdebenz's own crowdsourced
 *     reports (not disagreement with tbank) - surfaced as-is on
 *     GdebenzStation for admins reviewing a match, not folded into `status`.
 */

const { normalizeFuelType } = require('../utils/fuelTypeNormalizer');

// "queue" (there's a line at the pump) means the fuel is physically there,
// just busy - counts as available for "is there fuel" purposes, same as a
// confirmed "yes".
const STATUS_MAP = {
  yes: 'available',
  queue: 'available',
  low: 'maybe_available',
  no: 'not_available',
};

function mapStatus(rawStatus) {
  if (rawStatus === null || rawStatus === undefined) return 'no_data';
  return STATUS_MAP[rawStatus] || 'no_data';
}

// "92,95,ДТ" -> ["92", "95", "ДТ"]. Empty/missing means gdebenz isn't
// claiming any specific fuel type is available right now (typically when
// status is "no"). Each token is run through the shared fuel type
// normalizer (see utils/fuelTypeNormalizer.js) so gdebenz's own "ДТ"
// spelling lines up with however other sources name the same fuel.
function parseFuelsNow(value) {
  if (!value || typeof value !== 'string') return [];
  return value
    .split(',')
    .map((s) => normalizeFuelType(s.trim()))
    .filter(Boolean);
}

function extractGdebenzStationsArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const candidates = [payload.stations, payload.data, payload.items];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function parseGdebenzStation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const lat = Number(raw.lat);
  const lon = Number(raw.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const externalId = raw.osm_id !== undefined && raw.osm_id !== null ? String(raw.osm_id) : null;
  if (!externalId) return null;

  return {
    externalId,
    name: raw.name || null,
    brand: raw.brand || null,
    address: raw.addr || null,
    lat,
    lon,
    status: mapStatus(raw.status),
    fuelTypes: parseFuelsNow(raw.fuels_now),
    conflict: raw.conflict ?? null,
    raw,
  };
}

module.exports = { parseGdebenzStation, extractGdebenzStationsArray, mapStatus, parseFuelsNow };
