import { computed } from 'vue';
import { sortFuelTypes } from '../utils/fuelStatus';

// Only a fallback for a source with no genuine per-fuel data at all
// (gdebenz, or an un-upgraded sberazs station - see resolveSourceFuelReading
// below) - mirrors mergeStatusService.js's own
// projectStationStatusOntoFuelType, just for display: this never decides
// anything, only shows the same coarse reading the backend's merge falls
// back to for these sources.
function projectSourceStatusOntoFuelType(status, fuelTypes, fuelType) {
  if (status === 'not_available') return 'not_available';
  if (!status || status === 'no_data') return null;
  return (fuelTypes || []).includes(fuelType) ? status : null;
}

// Prefers the source's own genuine per-fuel-type reading (`fuelStatuses`,
// see GET /stations/:id's sources[].fuelStatuses) over the blanket-status
// projection above, the same priority order mergeStationFuelStatuses uses
// server-side (backend/src/services/mergeStatusService.js) - without this, a
// source that actually differentiates by fuel type (alfabank always,
// sberazs on upgraded stations) would have that real distinction thrown away
// here and re-derived as one uniform status for every type, even though the
// merge itself never does that. Returns null (not a row) when the source has
// no opinion on this fuel type at all, same as the projection did.
function resolveSourceFuelReading(source, fuelType) {
  const entry = (source.fuelStatuses || []).find((f) => f.fuelType === fuelType);
  if (entry) return { status: entry.status, lastTransactionAt: entry.lastTransactionAt || null };
  const projected = projectSourceStatusOntoFuelType(source.status, source.fuelTypes, fuelType);
  return projected ? { status: projected, lastTransactionAt: null } : null;
}

/**
 * Union of every fuel type tbank or any matched secondary source mentions,
 * each row showing what each source itself said side by side with the
 * merged result - shared between StationSourcesModal.vue (admin) and
 * StationDetailModal.vue (map/reports), which used to each duplicate this
 * computation for exactly one hardcoded "gdebenz" column.
 *
 * `stationRef` must resolve to an object shaped like the GET /stations/:id
 * response: `tbankLastFuelStatuses`, `lastFuelStatuses` (the merged
 * result), and `sources` (array of `{key, label, status, fuelTypes,
 * fuelStatuses}`, one per currently-linked secondary source).
 *
 * Each `bySource[key]` entry is `{status, lastTransactionAt} | null` (not a
 * bare status string) so templates can show per-source recency alongside the
 * status itself - see formatRelativeAge in utils/fuelStatus.js.
 */
export function useSourceFuelRows(stationRef) {
  return computed(() => {
    const station = stationRef.value;
    if (!station) return [];

    const tbankByType = new Map((station.tbankLastFuelStatuses || []).map((f) => [f.fuelType, f.status]));
    const mergedByType = new Map((station.lastFuelStatuses || []).map((f) => [f.fuelType, f.status]));
    const sources = station.sources || [];

    const allTypes = new Set(tbankByType.keys());
    for (const s of sources) {
      for (const fuelType of s.fuelTypes || []) allTypes.add(fuelType);
      for (const f of s.fuelStatuses || []) allTypes.add(f.fuelType);
    }
    for (const fuelType of mergedByType.keys()) allTypes.add(fuelType);

    return sortFuelTypes([...allTypes]).map((fuelType) => {
      const bySource = {};
      for (const s of sources) {
        bySource[s.key] = resolveSourceFuelReading(s, fuelType);
      }
      return {
        fuelType,
        tbank: tbankByType.get(fuelType) || null,
        bySource,
        merged: mergedByType.get(fuelType) || null,
      };
    });
  });
}
