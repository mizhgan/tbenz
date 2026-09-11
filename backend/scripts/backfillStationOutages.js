// One-off migration for the StationOutage rollup (see the metricsService.js
// report-performance plan): populates StationOutage from existing raw
// StationSnapshot history, since ingestService.js's incremental hook (see
// Station.openOutages's own doc comment) only starts capturing outages from
// its own deploy time forward. Without this, a report for "the last year"
// run right after that deploy would show correct availability-percentage
// counts (those come straight from raw StationSnapshot, unaffected) but
// zero/incomplete outageCount/avgOutageMinutes/recovery-trend data for
// everything before the deploy.
//
// Streams each (region, station) pair's history via a cursor rather than
// loading it as an array - the exact mistake that OOM-killed mongod in the
// incident this migration exists to fix the aftermath of (see
// metricsService.js's getStationMetricsUncached doc comment).
//
// Safe to re-run: deletes and recomputes StationOutage rows (and any open
// Station.openOutages entry) for a given (region, station) pair from scratch
// each time, rather than appending - also the natural reconciliation path if
// the live incremental hook and raw history ever drift (see
// ingestService.js's advanceOutageState doc comment on why that's possible).
//
// Usage:
//   node scripts/backfillStationOutages.js            # dry run, no writes
//   node scripts/backfillStationOutages.js --apply     # actually performs the backfill

const { connectDb, mongoose } = require('../src/db/mongoose');
const Region = require('../src/models/Region');
const Station = require('../src/models/Station');
const StationSnapshot = require('../src/models/StationSnapshot');
const StationOutage = require('../src/models/StationOutage');
const { computeOutages } = require('../src/services/metricsService');

const APPLY = process.argv.includes('--apply');

// Streams one (region, station) pair's history via a cursor into an array
// (bounded by that one pair's own history - even a full year is only ~52k
// small {status,polledAt} docs, nowhere near the ~1M-doc, all-stations-at-once
// read that caused the incident this migration exists for) and hands it to
// the same computeOutages metricsService.js already uses/tests, rather than
// re-deriving the streak rules a third time here.
async function computeOutagesForPair(region, stationId) {
  const cursor = StationSnapshot.find({ region: region._id, station: stationId }, { polledAt: 1, status: 1 })
    .sort({ polledAt: 1 })
    .lean()
    .cursor();

  const history = [];
  for await (const snap of cursor) history.push(snap);

  const { outages, openStartedAt } = computeOutages(history);
  return {
    outages: outages.map((o) => ({ station: stationId, region: region._id, ...o })),
    openStartedAt,
  };
}

async function main() {
  await connectDb();
  console.log(`Mode: ${APPLY ? 'APPLY (will modify data)' : 'DRY RUN (no changes will be made)'}\n`);

  const regions = await Region.find({}, { name: 1 });
  console.log(`Found ${regions.length} region(s).\n`);

  let pairsProcessed = 0;
  let outagesWritten = 0;
  let stillOpen = 0;

  for (const region of regions) {
    const stationIds = await StationSnapshot.distinct('station', { region: region._id });
    console.log(`Region "${region.name}": ${stationIds.length} station(s) with history.`);

    for (const stationId of stationIds) {
      const { outages, openStartedAt } = await computeOutagesForPair(region, stationId);
      pairsProcessed += 1;
      outagesWritten += outages.length;
      if (openStartedAt) stillOpen += 1;

      if (!APPLY) continue;

      await StationOutage.deleteMany({ region: region._id, station: stationId });
      if (outages.length) await StationOutage.insertMany(outages);

      await Station.updateOne({ _id: stationId }, { $pull: { openOutages: { region: region._id } } });
      if (openStartedAt) {
        await Station.updateOne(
          { _id: stationId },
          { $push: { openOutages: { region: region._id, startedAt: openStartedAt } } }
        );
      }
    }
  }

  console.log(
    `\n${APPLY ? 'Processed' : 'Would process'}: ${pairsProcessed} (region, station) pair(s). ` +
      `${APPLY ? 'Wrote' : 'Would write'} ${outagesWritten} StationOutage row(s). ` +
      `${stillOpen} pair(s) left with a trailing open outage.`
  );
  if (!APPLY) {
    console.log('Re-run with --apply to perform the backfill.');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
