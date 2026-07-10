// One-off cleanup for the sberazsParser.js fix: sberazs reports a combined
// "ai98_100" fuel type (AI-98/AI-100 sold through one nozzle at some pumps)
// that wasn't in FUEL_TYPE_MAP, so it passed through unnormalized and got
// stored as a fuel type distinct from "100" - including, for stations also
// polled by tbank/gdebenz (which report plain "100"), two separate entries
// in the same merged lastFuelStatuses/fuelStatuses array that the merge/
// display layer then treated as two unrelated fuel types instead of one
// (verified live: 67 of 291 affected StationSnapshot documents had both
// "ai98_100" and "100" side by side).
//
// Re-normalizes every already-stored "ai98_100" to "100", and for any array
// that ends up with two entries collapsing onto "100", combines their
// statuses with mergeStatusService's own resolveVotes (equal weight) instead
// of arbitrarily picking one - the same logic an actual merge would have
// used had the two readings already shared one fuel type name (same
// approach as scripts/normalizeFuelTypes.js's diesel/ДТ fix).
//
// Usage:
//   node scripts/mergeAi98100FuelType.js            # dry run, no writes
//   node scripts/mergeAi98100FuelType.js --apply    # actually performs the fix

const { connectDb, mongoose } = require('../src/db/mongoose');
const Station = require('../src/models/Station');
const SberazsStation = require('../src/models/SberazsStation');
const StationSnapshot = require('../src/models/StationSnapshot');
const { resolveVotes } = require('../src/services/mergeStatusService');

const APPLY = process.argv.includes('--apply');
const FROM_TYPE = 'ai98_100';
const TO_TYPE = '100';

function remapFuelType(type) {
  return type === FROM_TYPE ? TO_TYPE : type;
}

function normalizeFuelTypeArray(fuelTypes) {
  const before = fuelTypes || [];
  const set = new Set(before.map(remapFuelType));
  const after = [...set];
  return { after, changed: after.length !== before.length || before.some((t, i) => t !== after[i]) };
}

function normalizeFuelStatusArray(fuelStatuses) {
  const before = fuelStatuses || [];
  const byType = new Map();
  for (const f of before) {
    const norm = remapFuelType(f.fuelType);
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
  const changed = after.length !== before.length || before.some((f) => f.fuelType !== remapFuelType(f.fuelType));
  return { after, changed };
}

async function fixSberazsStations() {
  const docs = await SberazsStation.find({ fuelTypes: FROM_TYPE });
  console.log(`SberazsStation: ${docs.length} document(s) with "${FROM_TYPE}"`);
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
    $or: [{ 'tbankLastFuelStatuses.fuelType': FROM_TYPE }, { 'lastFuelStatuses.fuelType': FROM_TYPE }],
  });
  console.log(`Station: ${docs.length} document(s) with "${FROM_TYPE}"`);
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
  const docs = await StationSnapshot.find({ 'fuelStatuses.fuelType': FROM_TYPE });
  console.log(`StationSnapshot: ${docs.length} document(s) with "${FROM_TYPE}"`);
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

  await fixSberazsStations();
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
