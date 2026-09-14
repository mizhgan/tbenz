// One-off cleanup for the poll-status unification: removing a field from a
// Mongoose schema doesn't delete it from already-stored MongoDB documents -
// Region.lastPolledAt/lastPollStatus/lastPollError/lastPollStationCount/
// lastRequestUrl/lastRawResponse (superseded by Region.sourcePollStatus,
// tbank now written there like every other source - see
// services/regionPollStatus.js) would otherwise keep leaking back out of any
// query that doesn't use an explicit field projection - confirmed live: this
// is exactly what happened to the public /api/regions response (leaked a raw
// tbank payload) in the window between deploying the schema change and
// regions.controller.js's LEGACY_POLL_FIELDS exclusion patch. That exclusion
// list stays in place as a permanent safety net regardless of whether this
// script has been run - this script just stops the fields existing at all,
// same as dropLegacySourceFields.js did for the source-generalization
// refactor before this one.
//
// Usage:
//   node scripts/backfillDropLegacyPollFields.js            # dry run, no writes
//   node scripts/backfillDropLegacyPollFields.js --apply    # actually removes the fields

const { connectDb, mongoose } = require('../src/db/mongoose');
const Region = require('../src/models/Region');

const APPLY = process.argv.includes('--apply');

async function main() {
  await connectDb();
  console.log(`Mode: ${APPLY ? 'APPLY (will modify data)' : 'DRY RUN (no changes will be made)'}\n`);

  const regionCount = await Region.collection.countDocuments({ lastPollStatus: { $exists: true } });
  console.log(`Region documents with stray legacy poll-status fields: ${regionCount}`);
  if (APPLY && regionCount > 0) {
    const { modifiedCount } = await Region.collection.updateMany(
      { lastPollStatus: { $exists: true } },
      {
        $unset: {
          lastPolledAt: '',
          lastPollStatus: '',
          lastPollError: '',
          lastPollStationCount: '',
          lastRequestUrl: '',
          lastRawResponse: '',
        },
      }
    );
    console.log(`  -> unset on ${modifiedCount} document(s)`);
  }

  if (!APPLY && regionCount > 0) {
    console.log('\nRe-run with --apply to remove these fields.');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
