// One-off cleanup for the fuelTypeNormalizer.js fix: gdebenz has always
// named diesel "ДТ" (its own free-text `fuels_now` field) while sberazs
// names it "diesel" - before the parsers were fixed to normalize both onto
// one canonical string, already-stored documents ended up with both
// spellings side by side (verified live: a station matched to both gdebenz
// and sberazs had "diesel" AND "ДТ" as separate entries in its merged
// lastFuelStatuses, which the merge/display layer then treated as two
// unrelated fuel types instead of merging them).
//
// This script re-normalizes every already-stored fuel type string via the
// same normalizeFuelType() the parsers now use, and for any array that ends
// up with two entries collapsing onto the same canonical type, combines
// their statuses with mergeStatusService's own resolveVotes (equal weight)
// instead of arbitrarily picking one - the same logic an actual merge would
// have used had the two readings already shared one fuel type name.
//
// Usage:
//   node scripts/normalizeFuelTypes.js            # dry run, no writes
//   node scripts/normalizeFuelTypes.js --apply    # actually performs the fix

const { connectDb, mongoose } = require('../src/db/mongoose');
const Station = require('../src/models/Station');
const GdebenzStation = require('../src/models/GdebenzStation');
const SberazsStation = require('../src/models/SberazsStation');
const StationSnapshot = require('../src/models/StationSnapshot');
const { normalizeFuelType } = require('../src/utils/fuelTypeNormalizer');
const { resolveVotes } = require('../src/services/mergeStatusService');

const APPLY = process.argv.includes('--apply');

// Aliases only - not "ДТ" itself, so a query for "does this array contain a
// type that needs fixing" doesn't also match already-canonical documents.
const ALIAS_VALUES = ['diesel', 'dt', 'DT', 'Dt', 'дт', 'Дт', 'дизель', 'dizel'];

function normalizeFuelTypeArray(fuelTypes) {
  const before = fuelTypes || [];
  const set = new Set(before.map(normalizeFuelType));
  const after = [...set];
  return { after, changed: after.length !== before.length || before.some((t, i) => t !== after[i]) };
}

function normalizeFuelStatusArray(fuelStatuses) {
  const before = fuelStatuses || [];
  const byType = new Map();
  for (const f of before) {
    const norm = normalizeFuelType(f.fuelType);
    if (byType.has(norm)) {
      const existing = byType.get(norm);
      byType.set(
        norm,
        resolveVotes([
          { status: existing, weight: 1 },
          { status: f.status, weight: 1 },
        ]).status
      );
    } else {
      byType.set(norm, f.status);
    }
  }
  const after = [...byType.entries()].map(([fuelType, status]) => ({ fuelType, status }));
  const changed = after.length !== before.length || before.some((f) => f.fuelType !== normalizeFuelType(f.fuelType));
  return { after, changed };
}

async function fixSecondarySourceCollection(Model, label) {
  const docs = await Model.find({ fuelTypes: { $in: ALIAS_VALUES } });
  console.log(`${label}: ${docs.length} document(s) with a non-canonical fuel type`);
  for (const doc of docs) {
    const { after, changed } = normalizeFuelTypeArray(doc.fuelTypes);
    if (!changed) continue;
    console.log(`  ${doc._id} (${doc.name || '?'}): ${JSON.stringify(doc.fuelTypes)} -> ${JSON.stringify(after)}`);
    if (APPLY) {
      doc.fuelTypes = after;
      await doc.save();
    }
  }
}

async function fixStations() {
  const docs = await Station.find({
    $or: [
      { 'tbankLastFuelStatuses.fuelType': { $in: ALIAS_VALUES } },
      { 'lastFuelStatuses.fuelType': { $in: ALIAS_VALUES } },
    ],
  });
  console.log(`Station: ${docs.length} document(s) with a non-canonical fuel type`);
  for (const doc of docs) {
    const tbank = normalizeFuelStatusArray(doc.tbankLastFuelStatuses);
    const merged = normalizeFuelStatusArray(doc.lastFuelStatuses);
    if (!tbank.changed && !merged.changed) continue;
    console.log(`  ${doc._id} (${doc.name || '?'}):`);
    if (tbank.changed) {
      console.log(`    tbankLastFuelStatuses: ${JSON.stringify(doc.tbankLastFuelStatuses)} -> ${JSON.stringify(tbank.after)}`);
    }
    if (merged.changed) {
      console.log(`    lastFuelStatuses: ${JSON.stringify(doc.lastFuelStatuses)} -> ${JSON.stringify(merged.after)}`);
    }
    if (APPLY) {
      if (tbank.changed) doc.tbankLastFuelStatuses = tbank.after;
      if (merged.changed) doc.lastFuelStatuses = merged.after;
      await doc.save();
    }
  }
}

async function fixSnapshots() {
  const docs = await StationSnapshot.find({ 'fuelStatuses.fuelType': { $in: ALIAS_VALUES } });
  console.log(`StationSnapshot: ${docs.length} document(s) with a non-canonical fuel type`);
  let fixed = 0;
  for (const doc of docs) {
    const { after, changed } = normalizeFuelStatusArray(doc.fuelStatuses);
    if (!changed) continue;
    fixed += 1;
    if (APPLY) {
      await StationSnapshot.updateOne({ _id: doc._id }, { $set: { fuelStatuses: after } });
    }
  }
  console.log(`  ${APPLY ? 'Fixed' : 'Would fix'}: ${fixed}`);
}

async function main() {
  await connectDb();
  console.log(`Mode: ${APPLY ? 'APPLY (will modify data)' : 'DRY RUN (no changes will be made)'}\n`);

  await fixSecondarySourceCollection(GdebenzStation, 'GdebenzStation');
  await fixSecondarySourceCollection(SberazsStation, 'SberazsStation');
  await fixStations();
  await fixSnapshots();

  if (!APPLY) {
    console.log('\nRe-run with --apply to perform the fix.');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
