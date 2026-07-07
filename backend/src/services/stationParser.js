/**
 * Best-effort, defensive parsing of the toplivo.tbank.ru station payload.
 *
 * IMPORTANT: the exact response shape has not been verified against a live
 * call (the API host is unreachable from this dev sandbox). Field names
 * below are educated guesses covering the most common conventions. The full
 * raw object is always preserved (Station.lastRaw / StationSnapshot.raw) so
 * data is never lost even if these guesses are wrong - adjust the
 * `parseStation` mapping below once the real payload has been inspected.
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
  const candidates = [
    payload.stations,
    payload.data,
    payload.items,
    payload.result,
    payload.results,
    payload.data && payload.data.stations,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function parseLatLon(raw) {
  let lat = toFiniteNumber(firstDefined(raw.lat, raw.latitude, raw.point && raw.point.lat));
  let lon = toFiniteNumber(
    firstDefined(raw.lon, raw.lng, raw.longitude, raw.point && raw.point.lon)
  );

  if ((lat === undefined || lon === undefined) && Array.isArray(raw.coordinates)) {
    // GeoJSON-style [lon, lat]
    const [maybeLon, maybeLat] = raw.coordinates;
    lat = lat ?? toFiniteNumber(maybeLat);
    lon = lon ?? toFiniteNumber(maybeLon);
  }
  if ((lat === undefined || lon === undefined) && raw.location) {
    lat = lat ?? toFiniteNumber(raw.location.lat ?? raw.location.latitude);
    lon = lon ?? toFiniteNumber(raw.location.lon ?? raw.location.lng ?? raw.location.longitude);
  }

  if (lat === undefined || lon === undefined) return null;
  return { lat, lon };
}

function parseExternalId(raw, lat, lon) {
  const id = firstDefined(raw.id, raw.stationId, raw.station_id, raw.uuid, raw.code, raw._id);
  if (id !== undefined) return String(id);
  return `geo:${lat.toFixed(6)}:${lon.toFixed(6)}`;
}

function normalizeFuelEntry(item) {
  if (!item || typeof item !== 'object') return null;
  const type = firstDefined(item.type, item.name, item.fuelType, item.fuel_type, item.title);
  const price = toFiniteNumber(firstDefined(item.price, item.cost, item.value, item.amount));
  if (type === undefined || price === undefined) return null;
  return { type: String(type), price };
}

function parseFuels(raw) {
  const arrayCandidates = [
    raw.prices,
    raw.fuels,
    raw.fuelPrices,
    raw.fuel_prices,
    raw.offers,
    raw.products,
    raw.fuelTypes,
  ];
  for (const candidate of arrayCandidates) {
    if (Array.isArray(candidate)) {
      const parsed = candidate.map(normalizeFuelEntry).filter(Boolean);
      if (parsed.length) return parsed;
    }
  }

  const singleCandidate = firstDefined(raw.lastTransaction, raw.transaction, raw.last_transaction);
  const single = normalizeFuelEntry(singleCandidate);
  if (single) return [single];

  return [];
}

function parseStation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const latLon = parseLatLon(raw);
  if (!latLon) return null;

  const externalId = parseExternalId(raw, latLon.lat, latLon.lon);
  const name = firstDefined(raw.name, raw.stationName, raw.title) ?? null;
  const brand = firstDefined(raw.brand, raw.brandName, raw.network, raw.provider) ?? null;
  const address =
    firstDefined(raw.address, raw.addr, raw.location && raw.location.address) ?? null;
  const fuels = parseFuels(raw);

  return {
    externalId,
    name,
    brand,
    address,
    lat: latLon.lat,
    lon: latLon.lon,
    fuels,
    raw,
  };
}

module.exports = { extractStationsArray, parseStation };
