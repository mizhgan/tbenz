// One-off cleanup for Station documents left behind by Region.deleteRegion:
// deleteRegion (see regions.controller.js) correctly $pulls the deleted
// region's id out of every Station.regions and deletes that region's
// StationSnapshot history, but it never removes the Station documents
// themselves. A station that was only ever covered by the deleted region is
// left with regions: [] forever - no active region will poll it again, so it
// sits in the admin "Станции" list showing "—" for region and (eventually)
// "Нет данных" for tbank, with no way to tell it apart from a real data gap.
//
// This only deletes a Station document when it is safely orphaned:
//   - regions is empty (no active region claims it)
//   - it has no confirmed secondary-source match (sourceLinks is empty), and
//     no secondary-source document still points at it via matchedStationId
// Anything else is left untouched and printed as "needs manual review".
//
// Usage:
//   node scripts/deleteOrphanedStations.js            # dry run, no writes
//   node scripts/deleteOrphanedStations.js --apply    # actually deletes

const { connectDb, mongoose } = require('../src/db/mongoose');
const Station = require('../src/models/Station');
const StationSnapshot = require('../src/models/StationSnapshot');
const TelegramChat = require('../src/models/TelegramChat');
const { listSources } = require('../src/services/sourceRegistry');

const APPLY = process.argv.includes('--apply');

async function main() {
  await connectDb();
  console.log(`Mode: ${APPLY ? 'APPLY (will delete data)' : 'DRY RUN (no changes will be made)'}\n`);

  const candidates = await Station.find({ regions: { $size: 0 } }).lean();
  console.log(`Found ${candidates.length} Station document(s) with an empty regions[].\n`);

  let deleted = 0;
  let skipped = 0;

  for (const station of candidates) {
    const label = `${station._id} (${station.name} / ${station.address})`;

    if ((station.sourceLinks || []).length > 0) {
      console.log(`SKIP  ${label}: has a confirmed secondary-source match - needs manual review`);
      skipped += 1;
      continue;
    }

    let pointedAtBy = null;
    for (const source of listSources({ onlyEnabled: false })) {
      const doc = await source.model.findOne({ matchedStationId: station._id }, { _id: 1 }).lean();
      if (doc) {
        pointedAtBy = source.key;
        break;
      }
    }
    if (pointedAtBy) {
      console.log(`SKIP  ${label}: a ${pointedAtBy} document still points at it - needs manual review`);
      skipped += 1;
      continue;
    }

    const watchlistedBy = await TelegramChat.countDocuments({ watchlist: station._id });
    if (watchlistedBy > 0) {
      console.log(`SKIP  ${label}: still on ${watchlistedBy} Telegram watchlist(s) - needs manual review`);
      skipped += 1;
      continue;
    }

    console.log(`DELETE ${label}`);

    if (APPLY) {
      const { deletedCount: snapshotsDeleted } = await StationSnapshot.deleteMany({ station: station._id });
      await Station.deleteOne({ _id: station._id });
      console.log(`       ${snapshotsDeleted} leftover snapshot(s) deleted`);
    }

    deleted += 1;
  }

  console.log(`\n${APPLY ? 'Deleted' : 'Would delete'}: ${deleted}. Needs manual review (skipped): ${skipped}.`);
  if (!APPLY && deleted > 0) {
    console.log('Re-run with --apply to perform the deletion.');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
