// One-off migration for the sourceLinks generalization (see the refactor
// plan's Stage 1): populates Station.sourceLinks from the existing
// gdebenzStationId field for every already-matched station, so the
// generalized field starts in sync with the field it's dual-writing
// alongside from here on (see stationMatching.controller.js).
//
// Safe to re-run: skips any station that already has a matching sourceLinks
// entry instead of pushing a duplicate.
//
// Usage:
//   node scripts/backfillSourceLinks.js            # dry run, no writes
//   node scripts/backfillSourceLinks.js --apply     # actually performs the backfill

const { connectDb, mongoose } = require('../src/db/mongoose');
const Station = require('../src/models/Station');
const GdebenzStation = require('../src/models/GdebenzStation');

const APPLY = process.argv.includes('--apply');
const SOURCE_KEY = 'gdebenz';

async function main() {
  await connectDb();
  console.log(`Mode: ${APPLY ? 'APPLY (will modify data)' : 'DRY RUN (no changes will be made)'}\n`);

  const stations = await Station.find(
    { gdebenzStationId: { $ne: null } },
    { gdebenzStationId: 1, sourceLinks: 1, name: 1 }
  );

  console.log(`Found ${stations.length} Station document(s) with a gdebenzStationId set.\n`);

  let backfilled = 0;
  let alreadyInSync = 0;

  for (const station of stations) {
    const existing = (station.sourceLinks || []).find(
      (l) => l.sourceKey === SOURCE_KEY && String(l.refId) === String(station.gdebenzStationId)
    );
    if (existing) {
      alreadyInSync += 1;
      continue;
    }

    console.log(`BACKFILL ${station._id} (${station.name || '?'}) -> sourceLinks += {gdebenz, ${station.gdebenzStationId}}`);
    if (APPLY) {
      await Station.updateOne(
        { _id: station._id },
        { $pull: { sourceLinks: { sourceKey: SOURCE_KEY } } }
      );
      await Station.updateOne(
        { _id: station._id },
        { $addToSet: { sourceLinks: { sourceKey: SOURCE_KEY, refId: station.gdebenzStationId } } }
      );
    }
    backfilled += 1;
  }

  console.log(
    `\n${APPLY ? 'Backfilled' : 'Would backfill'}: ${backfilled}. Already in sync: ${alreadyInSync}.`
  );
  if (!APPLY && backfilled > 0) {
    console.log('Re-run with --apply to perform the backfill.');
  }

  if (APPLY) {
    const linkedCount = await Station.countDocuments({
      sourceLinks: { $elemMatch: { sourceKey: SOURCE_KEY } },
    });
    const matchedGdebenzCount = await GdebenzStation.countDocuments({ matchedStationId: { $ne: null } });
    const verb = linkedCount === matchedGdebenzCount ? 'OK' : 'MISMATCH';
    console.log(
      `\nVerification: Station.sourceLinks gdebenz entries = ${linkedCount}, GdebenzStation.matchedStationId set = ${matchedGdebenzCount} -> ${verb}`
    );
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
