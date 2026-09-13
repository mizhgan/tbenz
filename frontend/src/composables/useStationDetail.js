import { ref } from 'vue';
import { stationsApi } from '../api/regions';
import { useAsyncAction } from './useAsyncAction';

/**
 * The station detail modal, opened from a station name in either table on
 * the reports page. The metrics endpoints that feed those tables only carry
 * aggregate stats (no lat/lon/live status/fuel breakdown), so opening the
 * modal means fetching the actual Station document and reshaping it into
 * the same snapshot-like shape MapView already passes in (status/
 * fuelStatuses/polledAt instead of the document's own lastStatus/
 * lastFuelStatuses/lastSeenAt field names).
 */
export function useStationDetail() {
  const detailStation = ref(null);
  const showDetailModal = ref(false);
  // Not useKeyedAsyncAction's Set - only one detail fetch is ever really in
  // flight (one click opens one modal), and the child tables' :loading-
  // station-id prop wants the specific id, not a has()-checkable collection.
  const detailLoadingId = ref(null);
  const { error: detailError, run: runOpenDetail } = useAsyncAction();

  async function openStationDetail(stationId) {
    detailLoadingId.value = stationId;
    const doc = await runOpenDetail(() => stationsApi.get(stationId), {
      fallbackMessage: 'Не удалось загрузить данные станции',
    });
    detailLoadingId.value = null;
    if (doc) {
      detailStation.value = {
        stationId: doc._id,
        name: doc.name,
        address: doc.address,
        lat: doc.lat,
        lon: doc.lon,
        status: doc.lastStatus,
        fuelStatuses: doc.lastFuelStatuses || [],
        overallLastTransactionAt: doc.overallLastTransactionAt,
        polledAt: doc.lastSeenAt,
      };
      showDetailModal.value = true;
    }
  }

  function closeDetailModal() {
    showDetailModal.value = false;
  }

  return {
    detailStation,
    showDetailModal,
    detailLoadingId,
    detailError,
    openStationDetail,
    closeDetailModal,
  };
}
