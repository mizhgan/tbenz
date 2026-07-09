// One-off cleanup for the source-generalization refactor: removing a field
// from a Mongoose schema doesn't delete it from already-stored MongoDB
// documents - Station.gdebenzStationId and Region.lastGdebenzPolledAt/
// lastGdebenzPollStatus/lastGdebenzPollError/lastGdebenzPollStationCount
// (superseded by Station.sourceLinks / Region.sourcePollStatus - see
// services/sourceRegistry.js) would otherwise keep leaking back out of any
// `.lean()` query that doesn't use an explicit field projection, even though
// nothing in the app reads or writes them anymore (verified via a
// repo-wide grep before dropping the fields from the schemas).
//
// Usage:
//   node scripts/dropLegacySourceFields.js            # dry run, no writes
//   node scripts/dropLegacySourceFields.js --apply    # actually removes the fields

const { connectDb, mongoose } = require('../src/db/mongoose');
const Station = require('../src/models/Station');
const Region = require('../src/models/Region');

const APPLY = process.argv.includes('--apply');

async function main() {
  await connectDb();
  console.log(`Mode: ${APPLY ? 'APPLY (will modify data)' : 'DRY RUN (no changes will be made)'}\n`);

  const stationCount = await Station.collection.countDocuments({ gdebenzStationId: { $exists: true } });
  console.log(`Station documents with a stray gdebenzStationId field: ${stationCount}`);
  if (APPLY && stationCount > 0) {
    const { modifiedCount } = await Station.collection.updateMany(
      { gdebenzStationId: { $exists: true } },
      { $unset: { gdebenzStationId: '' } }
    );
    console.log(`  -> unset on ${modifiedCount} document(s)`);
  }

  const regionCount = await Region.collection.countDocuments({ lastGdebenzPolledAt: { $exists: true } });
  console.log(`Region documents with stray lastGdebenz* fields: ${regionCount}`);
  if (APPLY && regionCount > 0) {
    const { modifiedCount } = await Region.collection.updateMany(
      { lastGdebenzPolledAt: { $exists: true } },
      {
        $unset: {
          lastGdebenzPolledAt: '',
          lastGdebenzPollStatus: '',
          lastGdebenzPollError: '',
          lastGdebenzPollStationCount: '',
        },
      }
    );
    console.log(`  -> unset on ${modifiedCount} document(s)`);
  }

  if (!APPLY && (stationCount > 0 || regionCount > 0)) {
    console.log('\nRe-run with --apply to remove these fields.');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
