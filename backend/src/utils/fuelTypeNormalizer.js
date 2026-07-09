// Each source names non-octane fuel types differently for the exact same
// real-world fuel - verified live: gdebenz reports diesel as "ДТ" (its own
// free-text `fuels_now` field, see gdebenzParser.js), sberazs reports it as
// "diesel" (see sberazsParser.js). Left unnormalized, the merge/display
// layer (mergeStatusService.js, StationSourcesModal.vue's fuel table) would
// treat these as two unrelated fuel types instead of merging them - showing
// duplicate rows for what a driver experiences as one fuel.
//
// Every source parser should run its fuel type strings through this before
// they're stored, so by the time a fuel type reaches the DB/merge/UI layer
// it's already canonical - this is the single place a newly-discovered
// synonym gets added, instead of patching each parser separately.
const FUEL_TYPE_ALIASES = {
  diesel: 'ДТ',
  dt: 'ДТ',
  дт: 'ДТ',
  dizel: 'ДТ',
};

function normalizeFuelType(rawType) {
  if (rawType === null || rawType === undefined) return rawType;
  const trimmed = String(rawType).trim();
  const canonical = FUEL_TYPE_ALIASES[trimmed.toLowerCase()];
  return canonical || trimmed;
}

module.exports = { normalizeFuelType };
