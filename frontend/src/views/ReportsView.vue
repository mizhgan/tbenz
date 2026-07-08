<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { regionsApi, stationsApi } from '../api/regions';
import { metricsApi } from '../api/metrics';
import { formatMinutes, formatPct } from '../utils/colorScale';
import TrendChart from '../components/TrendChart.vue';
import BrandsChart from '../components/BrandsChart.vue';
import AvailabilityHeatmap from '../components/AvailabilityHeatmap.vue';
import StationsTable from '../components/StationsTable.vue';
import StationDetailModal from '../components/StationDetailModal.vue';

const route = useRoute();

const regions = ref([]);
const selectedRegionId = ref(route.query.region || '');
const loading = ref(false);
const errorMessage = ref('');

// Station detail modal, opened from a station name in either table below.
// The metrics endpoints that feed those tables only carry aggregate stats
// (no lat/lon/live status/fuel breakdown), so opening the modal means
// fetching the actual Station document and reshaping it into the same
// snapshot-like shape MapView already passes in (status/fuelStatuses/
// polledAt instead of the document's own lastStatus/lastFuelStatuses/
// lastSeenAt field names).
const detailStation = ref(null);
const showDetailModal = ref(false);
const detailLoadingId = ref(null);
const detailError = ref('');

async function openStationDetail(stationId) {
  detailError.value = '';
  detailLoadingId.value = stationId;
  try {
    const doc = await stationsApi.get(stationId);
    detailStation.value = {
      stationId: doc._id,
      name: doc.name,
      address: doc.address,
      lat: doc.lat,
      lon: doc.lon,
      status: doc.lastStatus,
      fuelStatuses: doc.lastFuelStatuses || [],
      lastTransactionAt: doc.lastTransactionAt,
      polledAt: doc.lastSeenAt,
    };
    showDetailModal.value = true;
  } catch (err) {
    detailError.value = err.response?.data?.error || 'Не удалось загрузить данные станции';
  } finally {
    detailLoadingId.value = null;
  }
}

function closeDetailModal() {
  showDetailModal.value = false;
}

const now = Date.now();
const fromMs = ref(now - 7 * 24 * 60 * 60 * 1000);
const toMs = ref(now);

const trendBuckets = ref([]);
const forecastBuckets = ref([]);
const forecastDirection = ref('unknown');
const stations = ref([]);
const brands = ref([]);
const heatmapCells = ref([]);
const stationsSort = ref('best');

const sectionErrors = ref({
  trend: '',
  forecast: '',
  stations: '',
  brands: '',
  heatmap: '',
});

const DIRECTION_META = {
  improving: { label: 'Улучшается', icon: '📈', color: '#16a34a' },
  worsening: { label: 'Ухудшается', icon: '📉', color: '#dc2626' },
  stable: { label: 'Стабильно', icon: '➖', color: '#6b7280' },
  unknown: { label: 'Недостаточно данных', icon: '❔', color: '#6b7280' },
};

function msToLocalInputValue(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const fromInput = computed({
  get: () => msToLocalInputValue(fromMs.value),
  set: (v) => {
    const parsed = new Date(v).getTime();
    if (Number.isFinite(parsed)) {
      fromMs.value = parsed;
      loadMetrics();
    }
  },
});
const toInput = computed({
  get: () => msToLocalInputValue(toMs.value),
  set: (v) => {
    const parsed = new Date(v).getTime();
    if (Number.isFinite(parsed)) {
      toMs.value = parsed;
      loadMetrics();
    }
  },
});

function setPreset(hours) {
  toMs.value = Date.now();
  fromMs.value = toMs.value - hours * 60 * 60 * 1000;
  loadMetrics();
}

function pickBucketHours(spanMs) {
  const spanHours = spanMs / 3600000;
  if (spanHours <= 48) return 1;
  if (spanHours <= 24 * 14) return 24;
  return 24 * 7;
}

const summary = computed(() => {
  let weightedAvailable = 0;
  let weightForAvailable = 0;
  let weightedRecovery = 0;
  let outagesForRecovery = 0;
  let totalOutages = 0;

  for (const s of stations.value) {
    if (s.availablePct !== null) {
      weightedAvailable += s.availablePct * s.totalPolls;
      weightForAvailable += s.totalPolls;
    }
    totalOutages += s.outageCount;
    if (s.avgOutageMinutes !== null) {
      weightedRecovery += s.avgOutageMinutes * s.outageCount;
      outagesForRecovery += s.outageCount;
    }
  }

  return {
    stationCount: stations.value.length,
    overallAvailablePct: weightForAvailable > 0 ? weightedAvailable / weightForAvailable : null,
    totalOutages,
    avgRecoveryMinutes: outagesForRecovery > 0 ? weightedRecovery / outagesForRecovery : null,
  };
});

const highlightedStations = computed(() => {
  const dir = stationsSort.value === 'best' ? -1 : 1;
  return [...stations.value]
    .filter((s) => s.availablePct !== null)
    .sort((a, b) => dir * (a.availablePct - b.availablePct))
    .slice(0, 5);
});

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

function describeFailure(result) {
  return result.reason?.response?.data?.error || result.reason?.message || 'Не удалось загрузить';
}

// Each metric endpoint is independent - one failing (or returning slowly)
// must not blank out the others. Promise.all would reject as a whole and
// silently leave every section showing stale data from the previous period
// with no indication anything went wrong; Promise.allSettled lets each
// section update (or report its own error) on its own.
async function loadMetrics() {
  if (!selectedRegionId.value) return;
  loading.value = true;
  errorMessage.value = '';

  const regionId = selectedRegionId.value;
  const from = new Date(fromMs.value).toISOString();
  const to = new Date(toMs.value).toISOString();
  const bucketHours = pickBucketHours(toMs.value - fromMs.value);

  const [trendResult, forecastResult, stationsResult, brandsResult, heatmapResult] =
    await Promise.allSettled([
      metricsApi.trend(regionId, { from, to, bucketHours }),
      metricsApi.trendForecast(regionId, { from, to, bucketHours }),
      metricsApi.stations(regionId, { from, to }),
      metricsApi.brands(regionId, { from, to }),
      metricsApi.heatmap(regionId, { from, to }),
    ]);

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

  if (brandsResult.status === 'fulfilled') {
    brands.value = brandsResult.value.brands;
    sectionErrors.value.brands = '';
  } else {
    brands.value = [];
    sectionErrors.value.brands = describeFailure(brandsResult);
  }

  if (heatmapResult.status === 'fulfilled') {
    heatmapCells.value = heatmapResult.value.cells;
    sectionErrors.value.heatmap = '';
  } else {
    heatmapCells.value = [];
    sectionErrors.value.heatmap = describeFailure(heatmapResult);
  }

  loading.value = false;
}

async function handleRegionChange() {
  await loadMetrics();
}

onMounted(async () => {
  await loadRegions();
  if (selectedRegionId.value) await loadMetrics();
});
</script>

<template>
  <div class="reports-page">
    <div class="page-header">
      <h1>Отчёты</h1>
    </div>

    <div class="controls card">
      <div class="form-row region-select">
        <label>Район</label>
        <select v-model="selectedRegionId" @change="handleRegionChange">
          <option v-for="r in regions" :key="r._id" :value="r._id">{{ r.name }}</option>
        </select>
      </div>

      <div class="form-row">
        <label>С</label>
        <input type="datetime-local" v-model="fromInput" />
      </div>
      <div class="form-row">
        <label>По</label>
        <input type="datetime-local" v-model="toInput" />
      </div>

      <div class="presets">
        <button class="btn secondary" @click="setPreset(24)">24ч</button>
        <button class="btn secondary" @click="setPreset(24 * 7)">7д</button>
        <button class="btn secondary" @click="setPreset(24 * 30)">30д</button>
      </div>

      <button class="btn" :disabled="loading" @click="loadMetrics">
        {{ loading ? 'Загрузка...' : 'Обновить' }}
      </button>
    </div>

    <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>
    <p v-if="detailError" class="error-text">{{ detailError }}</p>

    <div class="kpi-grid">
      <div class="card kpi">
        <div class="kpi-value">{{ formatPct(summary.overallAvailablePct) }}</div>
        <div class="kpi-label">Общая доступность</div>
      </div>
      <div class="card kpi">
        <div class="kpi-value">{{ summary.stationCount }}</div>
        <div class="kpi-label">Станций в отчёте</div>
      </div>
      <div class="card kpi">
        <div class="kpi-value">{{ summary.totalOutages }}</div>
        <div class="kpi-label">Отключений за период</div>
      </div>
      <div class="card kpi">
        <div class="kpi-value">{{ formatMinutes(summary.avgRecoveryMinutes) }}</div>
        <div class="kpi-label">Среднее время восстановления</div>
      </div>
    </div>

    <div class="card section">
      <div class="section-header">
        <h2>Динамика доступности</h2>
        <span class="direction-badge" :style="{ color: DIRECTION_META[forecastDirection].color }">
          {{ DIRECTION_META[forecastDirection].icon }} {{ DIRECTION_META[forecastDirection].label }}
        </span>
      </div>
      <p v-if="sectionErrors.trend || sectionErrors.forecast" class="error-text">
        {{ sectionErrors.trend || sectionErrors.forecast }}
      </p>
      <TrendChart :buckets="trendBuckets" :forecast-buckets="forecastBuckets" />
      <p class="hint small">
        Пунктир — простая линейная экстраполяция последних данных, а не точный прогноз: это
        грубая оценка направления тренда, без учёта сезонности.
      </p>
    </div>

    <div class="two-col">
      <div class="card section">
        <div class="section-header">
          <h2>{{ stationsSort === 'best' ? 'Лучшие станции' : 'Худшие станции' }}</h2>
          <div class="sort-toggle">
            <button
              class="btn secondary"
              :class="{ active: stationsSort === 'best' }"
              @click="stationsSort = 'best'"
            >
              Лучшие
            </button>
            <button
              class="btn secondary"
              :class="{ active: stationsSort === 'worst' }"
              @click="stationsSort = 'worst'"
            >
              Худшие
            </button>
          </div>
        </div>
        <p v-if="sectionErrors.stations" class="error-text">{{ sectionErrors.stations }}</p>
        <StationsTable
          :stations="highlightedStations"
          :default-sort-dir="stationsSort === 'best' ? 'desc' : 'asc'"
          :loading-station-id="detailLoadingId"
          @select="openStationDetail"
        />
      </div>
      <div class="card section">
        <h2>Сравнение по сетям</h2>
        <p v-if="sectionErrors.brands" class="error-text">{{ sectionErrors.brands }}</p>
        <BrandsChart :brands="brands" />
      </div>
    </div>

    <div class="card section">
      <h2>Доступность по дню недели и часу</h2>
      <p v-if="sectionErrors.heatmap" class="error-text">{{ sectionErrors.heatmap }}</p>
      <AvailabilityHeatmap :cells="heatmapCells" />
    </div>

    <div class="card section">
      <h2>Все станции</h2>
      <p v-if="sectionErrors.stations" class="error-text">{{ sectionErrors.stations }}</p>
      <StationsTable
        :stations="stations"
        :loading-station-id="detailLoadingId"
        @select="openStationDetail"
      />
    </div>

    <StationDetailModal
      v-if="showDetailModal && detailStation"
      :station="detailStation"
      :region-id="selectedRegionId"
      @close="closeDetailModal"
    />
  </div>
</template>

<style scoped>
.reports-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.page-header h1 {
  font-size: 20px;
  margin: 0;
}

.controls {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}

.region-select select {
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid #ccd2d9;
  min-width: 200px;
}

.presets {
  display: flex;
  gap: 6px;
}

.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 16px;
}

.kpi {
  text-align: center;
}

.kpi-value {
  font-size: 28px;
  font-weight: 700;
}

.kpi-label {
  font-size: 13px;
  color: #667;
  margin-top: 4px;
}

.section h2 {
  font-size: 16px;
  margin-top: 0;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}

.section-header h2 {
  margin: 0;
}

.direction-badge {
  font-size: 14px;
  font-weight: 600;
}

.sort-toggle {
  display: flex;
  gap: 6px;
}

.sort-toggle .btn.active {
  background: #dbeafe;
  color: #1d4ed8;
}

.hint.small {
  font-size: 12px;
}

.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

/* Grid items default to min-width: auto, which refuses to shrink narrower
   than their content's intrinsic size - a station table with several
   columns wants to be wider than a phone screen, and without this the
   whole card (not just the table) balloons out to fit it, dragging the
   entire page into horizontal scroll. min-width: 0 lets the grid item
   shrink to its track's actual width, so the table's own overflow-x: auto
   (see StationsTable.vue's .table-wrap) is what scrolls, not the page. */
.two-col > * {
  min-width: 0;
}

@media (max-width: 900px) {
  .two-col {
    grid-template-columns: 1fr;
  }
}
</style>
