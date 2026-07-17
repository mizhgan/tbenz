import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { regionsApi } from '../api/regions';

function formatDateTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('ru-RU');
}

/**
 * Region selection, the historical time range/slider, and the station
 * snapshot at whatever moment the slider (or live mode) currently points
 * at - the data-loading half of the map page, independent of how that data
 * ends up drawn (see useMapMarkers, which watches `stations`/
 * `filteredStations` to render) or filtered (see useMapFilters, which
 * reads `stations` to derive those).
 *
 * `initialRegionId` seeds `selectedRegionId` (MapView.vue passes
 * route.query.region) - the caller is still responsible for the actual
 * first load (calling `loadRegions`/`loadRange`/`loadSnapshot` from
 * onMounted, after the Leaflet map itself exists), since that ordering is
 * the caller's concern, not this composable's.
 */
export function useRegionSnapshot(initialRegionId) {
  const regions = ref([]);
  const selectedRegionId = ref(initialRegionId || '');
  const range = ref({ from: null, to: null });
  const atMs = ref(Date.now());
  const stations = ref([]);
  const loadingStations = ref(false);
  // True only until the very first regions+range+snapshot sequence finishes
  // (see MapView.vue's onMounted) - drives the one-time skeleton treatment
  // for the controls bar (region select, filters, slider) so a slow
  // connection shows an obviously-still-loading placeholder shaped like the
  // real UI instead of an empty gap that then pops in all at once.
  // loadingStations above keeps covering every *subsequent* snapshot fetch
  // (slider drags, live refresh) with just the map's own spinner overlay.
  const initialLoading = ref(true);
  const errorMessage = ref('');
  const liveMode = ref(true);

  let sliderDebounceTimer = null;
  let snapshotRequestId = 0;
  let liveTimer = null;

  const hasRange = computed(() => range.value.from !== null && range.value.to !== null);
  const atLabel = computed(() => formatDateTime(atMs.value));
  const selectedRegion = computed(() => regions.value.find((r) => r._id === selectedRegionId.value) || null);

  async function loadRegions() {
    regions.value = await regionsApi.list();
    if (!selectedRegionId.value && regions.value.length) {
      selectedRegionId.value = regions.value[0]._id;
    }
  }

  async function loadRange() {
    if (!selectedRegionId.value) return;
    const r = await regionsApi.historyRange(selectedRegionId.value);
    if (!r.from || !r.to) {
      range.value = { from: null, to: null };
      stations.value = [];
      return;
    }
    const now = Date.now();
    const toMs = Math.max(new Date(r.to).getTime(), now);
    range.value = { from: new Date(r.from).getTime(), to: toMs };
    atMs.value = range.value.to;
  }

  async function loadSnapshot() {
    if (!selectedRegionId.value || !hasRange.value) return;
    const requestId = ++snapshotRequestId;
    loadingStations.value = true;
    errorMessage.value = '';
    try {
      const at = new Date(atMs.value).toISOString();
      const data = await regionsApi.snapshotAt(selectedRegionId.value, at);
      if (requestId !== snapshotRequestId) return; // a newer request has since started
      stations.value = data.stations;
    } catch (err) {
      if (requestId !== snapshotRequestId) return;
      errorMessage.value = 'Не удалось загрузить данные станций';
    } finally {
      if (requestId === snapshotRequestId) loadingStations.value = false;
    }
  }

  function handleSliderInput() {
    liveMode.value = atMs.value >= range.value.to;
    clearTimeout(sliderDebounceTimer);
    sliderDebounceTimer = setTimeout(loadSnapshot, 120);
  }

  async function handleSliderChange() {
    clearTimeout(sliderDebounceTimer);
    liveMode.value = atMs.value >= range.value.to;
    await loadSnapshot();
  }

  async function jumpToNow() {
    liveMode.value = true;
    await loadRange();
    await loadSnapshot();
  }

  // Self-managed: doesn't depend on the Leaflet map existing (unlike the
  // caller's own initial load - see this file's own doc comment), since the
  // first firing is always 20s away regardless of when in onMounted this
  // gets registered.
  onMounted(() => {
    liveTimer = setInterval(async () => {
      if (!liveMode.value || !selectedRegionId.value) return;
      await loadRange();
      await loadSnapshot();
    }, 20000);
  });
  onBeforeUnmount(() => {
    clearInterval(liveTimer);
    clearTimeout(sliderDebounceTimer);
  });

  return {
    regions,
    selectedRegionId,
    range,
    atMs,
    stations,
    loadingStations,
    initialLoading,
    errorMessage,
    liveMode,
    hasRange,
    atLabel,
    selectedRegion,
    loadRegions,
    loadRange,
    loadSnapshot,
    handleSliderInput,
    handleSliderChange,
    jumpToNow,
    formatDateTime,
  };
}
