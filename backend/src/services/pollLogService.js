const SourcePollLog = require('../models/SourcePollLog');
const logger = require('../utils/logger');

/**
 * Records one poll attempt (tbank or a secondary source) for a region.
 * Best-effort - a logging hiccup must never break ingestion, same reasoning
 * as every other best-effort write in the ingest path (see
 * ingestService.js/secondarySourceIngestService.js).
 */
async function recordPollAttempt({ region, sourceKey, status, error, stationCount }) {
  try {
    await SourcePollLog.create({
      region: region._id,
      sourceKey,
      status,
      error: error || null,
      stationCount: stationCount || 0,
    });
  } catch (err) {
    logger.error(`Failed to record poll log for ${sourceKey}:`, err.message);
  }
}

/**
 * Per-source summary for a region: attempt/error/"succeeded but returned
 * zero stations" counts within the trailing `windowMs` (default 24h), plus
 * the single latest attempt's own status/error/stationCount regardless of
 * window - so a source that hasn't polled in days still shows its last
 * known state instead of just disappearing from the summary.
 */
async function getPollStats(regionId, { windowMs = 24 * 60 * 60 * 1000 } = {}) {
  const since = new Date(Date.now() - windowMs);

  const [counts, latest] = await Promise.all([
    SourcePollLog.aggregate([
      { $match: { region: regionId, polledAt: { $gte: since } } },
      {
        $group: {
          _id: '$sourceKey',
          attempts: { $sum: 1 },
          errors: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
          emptyOk: {
            $sum: { $cond: [{ $and: [{ $eq: ['$status', 'ok'] }, { $eq: ['$stationCount', 0] }] }, 1, 0] },
          },
        },
      },
    ]),
    SourcePollLog.aggregate([
      { $match: { region: regionId } },
      { $sort: { polledAt: -1 } },
      { $group: { _id: '$sourceKey', doc: { $first: '$$ROOT' } } },
    ]),
  ]);

  const countsByKey = new Map(counts.map((c) => [c._id, c]));
  const latestByKey = new Map(latest.map((l) => [l._id, l.doc]));
  const sourceKeys = new Set([...countsByKey.keys(), ...latestByKey.keys()]);

  return [...sourceKeys].map((sourceKey) => {
    const c = countsByKey.get(sourceKey);
    const l = latestByKey.get(sourceKey);
    return {
      sourceKey,
      attempts24h: c?.attempts ?? 0,
      errors24h: c?.errors ?? 0,
      emptyOk24h: c?.emptyOk ?? 0,
      lastPolledAt: l?.polledAt ?? null,
      lastStatus: l?.status ?? null,
      lastError: l?.error ?? null,
      lastStationCount: l?.stationCount ?? null,
    };
  });
}

async function getRecentLogs(regionId, sourceKey, { limit = 50 } = {}) {
  return SourcePollLog.find({ region: regionId, sourceKey })
    .sort({ polledAt: -1 })
    .limit(Math.min(limit, 200))
    .lean();
}

module.exports = { recordPollAttempt, getPollStats, getRecentLogs };
