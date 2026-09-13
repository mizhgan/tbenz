import { computed, ref } from 'vue';
import { regionsApi } from '../api/regions';
import { metricsApi } from '../api/metrics';

function describeFailure(result) {
  return result.reason?.response?.data?.error || result.reason?.message || 'Не удалось загрузить';
}

/**
 * Region list/selection plus the actual metrics fetch for whatever period
 * useReportPeriod.js currently has selected - the "load the report's data"
 * half of the reports page, independent of the period itself (that's
 * useReportPeriod.js) and of how the loaded stations are summarized
 * (useReportSummary.js) or turned into a shareable image (useReportCard.js).
 *
 * `fromIso`/`toIso`/`prevFromIso`/`prevToIso`/`bucketHours` are refs/
 * computed owned by useReportPeriod.js, read live (via .value) whenever
 * loadMetrics actually runs, not captured once at construction. `onBeforeLoad`
 * fires at the very start of every loadMetrics run - ReportsView.vue passes
 * its own reportCard.resetReportCard, since a stale preview from a previous
 * region/period would be misleading once the underlying data has moved on.
 */
export function useReportMetrics({ fromIso, toIso, prevFromIso, prevToIso, bucketHours, initialRegionId, onBeforeLoad }) {
  const regions = ref([]);
  const selectedRegionId = ref(initialRegionId || '');
  const loading = ref(false);
  const errorMessage = ref('');

  const trendBuckets = ref([]);
  const forecastBuckets = ref([]);
  const forecastDirection = ref('unknown');
  const stations = ref([]);
  // Previous-period stations, fetched purely to compute previousSummary
  // (see useReportSummary.js) - never rendered as its own table/list.
  const previousStations = ref([]);
  const heatmapCells = ref([]);
  const recoveryTrendBuckets = ref([]);

  const sectionErrors = ref({
    trend: '',
    forecast: '',
    stations: '',
    heatmap: '',
    recoveryTrend: '',
  });

  const selectedRegion = computed(() => regions.value.find((r) => r._id === selectedRegionId.value) || null);

  async function loadRegions() {
    try {
      regions.value = await regionsApi.list();
      if (!selectedRegionId.value && regions.value.length) {
        selectedRegionId.value = regions.value[0]._id;
      }
    } catch (err) {
      errorMessage.value = err.response?.data?.error || 'Не удалось загрузить список районов';
    }
  }

  // Each metric endpoint is independent - one failing (or returning slowly)
  // must not blank out the others. Promise.all would reject as a whole and
  // silently leave every section showing stale data from the previous period
  // with no indication anything went wrong; Promise.allSettled lets each
  // section update (or report its own error) on its own.
  //
  // `requestToken` guards against a *slower older* call clobbering a *faster
  // newer* one - loadMetrics is re-triggered on region change, every preset
  // button, and every custom date edit, with no cancellation between calls.
  // Reported live: clicking a period preset shortly after the page's own
  // initial (default 7-day) load could still have that first call in flight;
  // whichever of the two happened to resolve *last* won the final
  // trendBuckets/recoveryTrendBuckets assignment regardless of which was
  // requested more recently - the generated report card then showed the
  // correct header/KPI/station-ribbon dates (those come from fresh reads at
  // generate time) next to trend/recovery charts still drawing the stale
  // period, reading as a jumble of mismatched dates on one image. Each call
  // captures its own token; a call whose token no longer matches the module-
  // level counter by the time its requests settle was superseded and skips
  // applying its (now-stale) results entirely.
  let requestToken = 0;

  async function loadMetrics() {
    if (!selectedRegionId.value) return;
    const myToken = ++requestToken;
    loading.value = true;
    errorMessage.value = '';
    onBeforeLoad?.();

    const regionId = selectedRegionId.value;
    const from = fromIso.value;
    const to = toIso.value;
    const prevFrom = prevFromIso.value;
    const prevTo = prevToIso.value;

    const [trendResult, forecastResult, stationsResult, heatmapResult, recoveryTrendResult, previousStationsResult] =
      await Promise.allSettled([
        metricsApi.trend(regionId, { from, to, bucketHours: bucketHours.value }),
        metricsApi.trendForecast(regionId, { from, to, bucketHours: bucketHours.value }),
        metricsApi.stations(regionId, { from, to }),
        metricsApi.heatmap(regionId, { from, to }),
        metricsApi.recoveryTrend(regionId, { from, to, bucketHours: bucketHours.value }),
        // Purely for the KPI cards' own "vs previous period" delta - a
        // failure here shouldn't surface as a visible page error for what's a
        // secondary, non-essential comparison; previousStations just stays
        // empty and the delta lines quietly don't render (see
        // useReportSummary.js's own null-guards).
        metricsApi.stations(regionId, { from: prevFrom, to: prevTo }),
      ]);

    if (myToken !== requestToken) return; // superseded by a newer call - discard

    if (trendResult.status === 'fulfilled') {
      trendBuckets.value = trendResult.value.buckets;
      sectionErrors.value.trend = '';
    } else {
      trendBuckets.value = [];
      sectionErrors.value.trend = describeFailure(trendResult);
    }

    if (forecastResult.status === 'fulfilled') {
      forecastBuckets.value = forecastResult.value.forecast;
      forecastDirection.value = forecastResult.value.direction;
      sectionErrors.value.forecast = '';
    } else {
      forecastBuckets.value = [];
      forecastDirection.value = 'unknown';
      sectionErrors.value.forecast = describeFailure(forecastResult);
    }

    if (stationsResult.status === 'fulfilled') {
      stations.value = stationsResult.value.stations;
      sectionErrors.value.stations = '';
    } else {
      stations.value = [];
      sectionErrors.value.stations = describeFailure(stationsResult);
    }

    if (heatmapResult.status === 'fulfilled') {
      heatmapCells.value = heatmapResult.value.cells;
      sectionErrors.value.heatmap = '';
    } else {
      heatmapCells.value = [];
      sectionErrors.value.heatmap = describeFailure(heatmapResult);
    }

    if (recoveryTrendResult.status === 'fulfilled') {
      recoveryTrendBuckets.value = recoveryTrendResult.value.buckets;
      sectionErrors.value.recoveryTrend = '';
    } else {
      recoveryTrendBuckets.value = [];
      sectionErrors.value.recoveryTrend = describeFailure(recoveryTrendResult);
    }

    previousStations.value = previousStationsResult.status === 'fulfilled' ? previousStationsResult.value.stations : [];

    loading.value = false;
  }

  return {
    regions,
    selectedRegionId,
    selectedRegion,
    loading,
    errorMessage,
    trendBuckets,
    forecastBuckets,
    forecastDirection,
    stations,
    previousStations,
    heatmapCells,
    recoveryTrendBuckets,
    sectionErrors,
    loadRegions,
    loadMetrics,
  };
}
