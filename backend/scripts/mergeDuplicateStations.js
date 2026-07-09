// One-off cleanup for Station documents that got split into duplicates
// before ingestService.storeStation switched to deduping by yandexOrgId
// instead of tbank's own externalId (see the doc comment on the Station
// model). Groups Station by yandexOrgId, and for every group of exactly two
// documents that matches the known-safe shape - same lat/lon/address, and
// the newer document has no secondary-source match of its own (see
// services/sourceRegistry.js) - merges the newer one into the older one:
// StationSnapshot history is repointed (not deleted), Telegram watchlist
// references are repointed, then the newer Station document is deleted.
//
// Any group that doesn't match that exact shape (more than 2 documents,
// disagreeing location/address, or the newer document already has its own
// confirmed secondary-source match) is left untouched and printed as "needs
// manual review" instead of being merged - this script never guesses.
//
// Usage:
//   node scripts/mergeDuplicateStations.js            # dry run, no writes
//   node scripts/mergeDuplicateStations.js --apply    # actually performs the merge

const { connectDb, mongoose } = require('../src/db/mongoose');
const Station = require('../src/models/Station');
const StationSnapshot = require('../src/models/StationSnapshot');
const TelegramChat = require('../src/models/TelegramChat');
const { listSources } = require('../src/services/sourceRegistry');

const APPLY = process.argv.includes('--apply');

async function mergeSnapshots(keepId, dropId) {
  const keepPolledAts = new Set(
    (await StationSnapshot.find({ station: keepId }, { polledAt: 1 }).lean()).map((s) =>
      s.polledAt.getTime()
    )
  );
  const dropSnapshots = await StationSnapshot.find({ station: dropId }, { _id: 1, polledAt: 1 }).lean();

  const toDelete = dropSnapshots.filter((s) => keepPolledAts.has(s.polledAt.getTime())).map((s) => s._id);
  const toReassign = dropSnapshots.filter((s) => !keepPolledAts.has(s.polledAt.getTime())).map((s) => s._id);

  if (toDelete.length) await StationSnapshot.deleteMany({ _id: { $in: toDelete } });
  if (toReassign.length) {
    await StationSnapshot.updateMany({ _id: { $in: toReassign } }, { $set: { station: keepId } });
  }
  return { deleted: toDelete.length, reassigned: toReassign.length };
}

async function repointWatchlists(keepId, dropId) {
  const affected = await TelegramChat.find({ watchlist: dropId }, { _id: 1 }).lean();
  for (const chat of affected) {
    // $pull and $addToSet on the same array path can't run in one update
    // call (Mongo rejects it as a path conflict), hence two calls.
    await TelegramChat.updateOne({ _id: chat._id }, { $pull: { watchlist: dropId } });
    await TelegramChat.updateOne({ _id: chat._id }, { $addToSet: { watchlist: keepId } });
  }
  return affected.length;
}

async function main() {
  await connectDb();
  console.log(`Mode: ${APPLY ? 'APPLY (will modify data)' : 'DRY RUN (no changes will be made)'}\n`);

  const groups = await Station.aggregate([
    { $match: { yandexOrgId: { $ne: null } } },
    { $sort: { firstSeenAt: 1 } },
    { $group: { _id: '$yandexOrgId', count: { $sum: 1 }, stations: { $push: '$$ROOT' } } },
    { $match: { count: { $gt: 1 } } },
  ]);

  console.log(`Found ${groups.length} yandexOrgId group(s) with more than one Station document.\n`);

  let merged = 0;
  let skipped = 0;

  for (const group of groups) {
    const label = `${group._id} (${group.stations[0]?.name || '?'} / ${group.stations[0]?.address || '?'})`;

    if (group.stations.length !== 2) {
      console.log(`SKIP  ${label}: ${group.stations.length} documents (expected exactly 2) - needs manual review`);
      skipped += 1;
      continue;
    }

    // $sort above ran before $group, so $push preserved order - oldest first.
    const [keep, drop] = group.stations;

    const sameLocation = keep.lat === drop.lat && keep.lon === drop.lon;
    const sameAddress = keep.address === drop.address;
    if (!sameLocation || !sameAddress) {
      console.log(`SKIP  ${label}: keep/drop disagree on location or address - needs manual review`);
      skipped += 1;
      continue;
    }

    if ((drop.sourceLinks || []).length > 0) {
      console.log(
        `SKIP  ${label}: newer document ${drop._id} already has its own secondary-source match - needs manual review`
      );
      skipped += 1;
      continue;
    }
    let pointedAtDropBy = null;
    for (const source of listSources({ onlyEnabled: false })) {
      const doc = await source.model.findOne({ matchedStationId: drop._id }, { _id: 1 }).lean();
      if (doc) {
        pointedAtDropBy = source.key;
        break;
      }
    }
    if (pointedAtDropBy) {
      console.log(`SKIP  ${label}: a ${pointedAtDropBy} document still points at the newer document - needs manual review`);
      skipped += 1;
      continue;
    }

    console.log(
      `MERGE ${label}: keep ${keep._id} (externalId ${keep.externalId}), drop ${drop._id} (externalId ${drop.externalId})`
    );

    if (APPLY) {
      const { deleted, reassigned } = await mergeSnapshots(keep._id, drop._id);
      const watchlistChats = await repointWatchlists(keep._id, drop._id);
      await Station.deleteOne({ _id: drop._id });
      console.log(
        `      snapshots: ${reassigned} reassigned, ${deleted} duplicate-timestamp ones dropped; ${watchlistChats} Telegram chat(s) repointed`
      );
    }

    merged += 1;
  }

  console.log(`\n${APPLY ? 'Merged' : 'Would merge'}: ${merged}. Needs manual review (skipped): ${skipped}.`);
  if (!APPLY && merged > 0) {
    console.log('Re-run with --apply to perform the merge.');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
