import { computed } from 'vue';
import { sortFuelTypes } from '../utils/fuelStatus';

// A secondary source (see backend/src/services/sourceRegistry.js) reports at
// station granularity, not per fuel type - mirrors mergeStatusService.js's
// own projectStationStatusOntoFuelType, just for display: this never
// decides anything, only shows the same per-source reading the backend's
// merge was actually computed from.
function projectSourceStatusOntoFuelType(status, fuelTypes, fuelType) {
  if (status === 'not_available') return 'not_available';
  if (!status || status === 'no_data') return null;
  return (fuelTypes || []).includes(fuelType) ? status : null;
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
 * result), and `sources` (array of `{key, label, status, fuelTypes}`, one
 * per currently-linked secondary source).
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
    }
    for (const fuelType of mergedByType.keys()) allTypes.add(fuelType);

    return sortFuelTypes([...allTypes]).map((fuelType) => {
      const bySource = {};
      for (const s of sources) {
        bySource[s.key] = projectSourceStatusOntoFuelType(s.status, s.fuelTypes, fuelType);
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
