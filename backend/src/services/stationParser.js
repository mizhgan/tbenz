/**
 * Parsing of the toplivo.tbank.ru station payload.
 *
 * Verified against a real sample response:
 *
 *   { "status": "ok", "payload": [
 *     {
 *       "id": "01KWVDAV7KA8JZR0A7Q22X4SJS",
 *       "name": "Движение",
 *       "addr": "Кировская область, ...",
 *       "lat": 58.454438,
 *       "lon": 49.262675,
 *       "status": "no_data",
 *       "statusByFuelType": { "92": "no_data", "95": "no_data" },
 *       "yandexOrgId": "1033437067",
 *       "lastTransactionAt": null
 *     }, ...
 *   ] }
 *
 * Note there is no price data - the source only reports a fuel *availability*
 * status per fuel type, inferred from how recently a card transaction was
 * seen at that pump: "available" | "maybe_available" | "not_available" |
 * "no_data". `lastTransactionAt` (nullable ISO string) is the most recent
 * transaction across all fuel types at the station.
 */

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function extractStationsArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const candidates = [payload.payload, payload.stations, payload.data, payload.items];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function parseLatLon(raw) {
  const lat = toFiniteNumber(firstDefined(raw.lat, raw.latitude));
  const lon = toFiniteNumber(firstDefined(raw.lon, raw.lng, raw.longitude));
  if (lat === undefined || lon === undefined) return null;
  return { lat, lon };
}

function parseFuelStatuses(raw) {
  const map = raw.statusByFuelType;
  if (!map || typeof map !== 'object') return [];
  return Object.entries(map).map(([fuelType, status]) => ({
    fuelType,
    status: String(status),
  }));
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseStation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const latLon = parseLatLon(raw);
  if (!latLon) return null;

  const externalId = firstDefined(raw.id, raw.stationId) ?? `geo:${latLon.lat.toFixed(6)}:${latLon.lon.toFixed(6)}`;

  return {
    externalId: String(externalId),
    name: raw.name ?? null,
    address: raw.addr ?? null,
    lat: latLon.lat,
    lon: latLon.lon,
    yandexOrgId: raw.yandexOrgId ? String(raw.yandexOrgId) : null,
    status: raw.status ?? 'no_data',
    fuelStatuses: parseFuelStatuses(raw),
    lastTransactionAt: parseDate(raw.lastTransactionAt),
    raw,
  };
}

module.exports = { extractStationsArray, parseStation };
