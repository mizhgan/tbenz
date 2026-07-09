const Station = require('../models/Station');
const { getSource } = require('./sourceRegistry');

const EARTH_RADIUS_M = 6371000;
const DEFAULT_RADIUS_M = 250;
const DEFAULT_LIMIT = 5;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, ' ')
    .trim();
}

// Not a real string-distance algorithm (Levenshtein etc.) - just enough to
// rank candidates for a human to pick from, not to decide anything by
// itself (see the module doc comment). Exact match > one name containing the
// other (common when one source includes a suffix like "АЗС №12") > word
// overlap > nothing in common.
function nameSimilarity(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.7;

  const wordsA = new Set(na.split(' ').filter(Boolean));
  const wordsB = new Set(nb.split(' ').filter(Boolean));
  if (!wordsA.size || !wordsB.size) return 0;
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union ? intersection / union : 0;
}

/**
 * Ranks candidate Stations for a given secondary-source station document
 * (see sourceRegistry.js), for an admin to pick from - never decides a match
 * by itself. Pre-filters by a bounding box around the target point (cheap,
 * uses the existing {lat,lon} index) before computing exact haversine
 * distance, since Station has no geospatial index set up for a real
 * $geoNear query.
 */
async function suggestMatches(secondaryDoc, sourceKey, { radiusMeters = DEFAULT_RADIUS_M, limit = DEFAULT_LIMIT } = {}) {
  const latDelta = radiusMeters / 111320;
  const lonDelta = radiusMeters / (111320 * Math.max(0.1, Math.cos(toRad(secondaryDoc.lat))));

  const boxCandidates = await Station.find(
    {
      lat: { $gte: secondaryDoc.lat - latDelta, $lte: secondaryDoc.lat + latDelta },
      lon: { $gte: secondaryDoc.lon - lonDelta, $lte: secondaryDoc.lon + lonDelta },
    },
    { name: 1, address: 1, lat: 1, lon: 1, sourceLinks: 1 }
  ).lean();

  const ranked = boxCandidates
    .map((station) => {
      const distanceMeters = haversineMeters(secondaryDoc.lat, secondaryDoc.lon, station.lat, station.lon);
      const similarity = Math.max(
        nameSimilarity(secondaryDoc.name, station.name),
        nameSimilarity(secondaryDoc.brand, station.name)
      );
      return {
        stationId: station._id,
        name: station.name,
        address: station.address,
        distanceMeters: Math.round(distanceMeters),
        nameSimilarity: similarity,
        alreadyMatched: (station.sourceLinks || []).some((l) => l.sourceKey === sourceKey),
        // Closer and more-similar-named candidates rank higher; distance is
        // in meters so it needs scaling down to not dominate a 0-1
        // similarity score.
        score: similarity * 100 - distanceMeters / 5,
      };
    })
    .filter((c) => c.distanceMeters <= radiusMeters)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return ranked;
}

/**
 * The reverse of suggestMatches(): ranks candidate secondary-source station
 * documents for a given Station, for the station-detail admin view's
 * "attach a source" flow - someone looking at one specific station (rather
 * than working through a source's own unmatched queue) who wants to find
 * its counterpart in that source. Excludes documents already matched to
 * some other Station, or that an admin has already dismissed as "not a
 * station / no match" (see stationMatching.controller.js's ignoreSecondary).
 */
async function suggestMatchesForStation(station, sourceKey, { radiusMeters = DEFAULT_RADIUS_M, limit = DEFAULT_LIMIT } = {}) {
  const sourceConfig = getSource(sourceKey);
  if (!sourceConfig) return [];

  const latDelta = radiusMeters / 111320;
  const lonDelta = radiusMeters / (111320 * Math.max(0.1, Math.cos(toRad(station.lat))));

  const boxCandidates = await sourceConfig.model
    .find(
      {
        matchedStationId: null,
        ignored: false,
        lat: { $gte: station.lat - latDelta, $lte: station.lat + latDelta },
        lon: { $gte: station.lon - lonDelta, $lte: station.lon + lonDelta },
      },
      { name: 1, brand: 1, address: 1, lat: 1, lon: 1, status: 1, fuelTypes: 1 }
    )
    .lean();

  const ranked = boxCandidates
    .map((doc) => {
      const distanceMeters = haversineMeters(station.lat, station.lon, doc.lat, doc.lon);
      const similarity = Math.max(nameSimilarity(station.name, doc.name), nameSimilarity(station.name, doc.brand));
      return {
        secondaryId: doc._id,
        name: doc.name,
        brand: doc.brand,
        address: doc.address,
        status: doc.status,
        fuelTypes: doc.fuelTypes,
        distanceMeters: Math.round(distanceMeters),
        nameSimilarity: similarity,
        score: similarity * 100 - distanceMeters / 5,
      };
    })
    .filter((c) => c.distanceMeters <= radiusMeters)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return ranked;
}

module.exports = { suggestMatches, suggestMatchesForStation, haversineMeters, nameSimilarity };
