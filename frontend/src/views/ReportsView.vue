<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { regionsApi, stationsApi } from '../api/regions';
import { metricsApi } from '../api/metrics';
import { formatMinutes, formatPct } from '../utils/colorScale';
import { renderRegionReportCard } from '../utils/regionReportCard';
import { canCopyImageToClipboard } from '../utils/stationCard';
import { canShareFile } from '../utils/mapExport';
import TrendChart from '../components/TrendChart.vue';
import RecoveryTrendChart from '../components/RecoveryTrendChart.vue';
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
const recoveryTrendBuckets = ref([]);
const stationsSort = ref('best');

const sectionErrors = ref({
  trend: '',
  forecast: '',
  stations: '',
  brands: '',
  heatmap: '',
  recoveryTrend: '',
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

const selectedRegion = computed(() => regions.value.find((r) => r._id === selectedRegionId.value) || null);

// Shareable report card - client-side canvas, same approach and UI pattern
// (generate -> preview -> copy/download/share) as the station card in
// StationDetailModal.vue.
const cardGenerating = ref(false);
const cardUrl = ref(null);
const cardError = ref('');
const copyFeedback = ref('');
const clipboardSupported = canCopyImageToClipboard();
let cardBlob = null;
let cardFile = null;
const canShareCard = computed(() => !!cardFile && canShareFile(cardFile));

function resetReportCard() {
  if (cardUrl.value) {
    URL.revokeObjectURL(cardUrl.value);
    cardUrl.value = null;
  }
  cardBlob = null;
  cardFile = null;
  cardError.value = '';
  copyFeedback.value = '';
}

async function generateReportCard() {
  cardError.value = '';
  copyFeedback.value = '';
  cardGenerating.value = true;
  try {
    const blob = await renderRegionReportCard({
      region: selectedRegion.value || { name: 'Район' },
      from: fromMs.value,
      to: toMs.value,
      summary: summary.value,
      trendBuckets: trendBuckets.value,
      forecastBuckets: forecastBuckets.value,
      direction: forecastDirection.value,
      topStations: highlightedStations.value.slice(0, 3),
      stationsLabel: stationsSort.value === 'best' ? 'Лучшие станции' : 'Худшие станции',
    });
    if (cardUrl.value) URL.revokeObjectURL(cardUrl.value);
    cardBlob = blob;
    cardUrl.value = URL.createObjectURL(blob);
    const safeName = (selectedRegion.value?.name || 'region').replace(/[^\p{L}\p{N}]+/gu, '-');
    cardFile = new File([blob], `${safeName}-report.png`, { type: 'image/png' });
  } catch (err) {
    cardError.value = `Не удалось создать картинку: ${err.message || 'неизвестная ошибка'}`;
  } finally {
    cardGenerating.value = false;
  }
}

async function copyReportCardToClipboard() {
  if (!cardBlob) return;
  copyFeedback.value = '';
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': cardBlob })]);
    copyFeedback.value = 'ok';
  } catch (err) {
    copyFeedback.value = 'error';
    cardError.value = `Не удалось скопировать: ${err.message || 'неизвестная ошибка'}`;
  }
}

async function shareReportCard() {
  if (!cardFile) return;
  try {
    await navigator.share({ files: [cardFile], title: `Отчёт: ${selectedRegion.value?.name || 'Район'}` });
  } catch (err) {
    if (err.name !== 'AbortError') {
      cardError.value = `Не удалось поделиться: ${err.message || 'неизвестная ошибка'}`;
    }
  }
}

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
  // A stale preview from a previous region/period would be misleading once
  // the underlying data has moved on.
  resetReportCard();

  const regionId = selectedRegionId.value;
  const from = new Date(fromMs.value).toISOString();
  const to = new Date(toMs.value).toISOString();
  const bucketHours = pickBucketHours(toMs.value - fromMs.value);

  const [trendResult, forecastResult, stationsResult, brandsResult, heatmapResult, recoveryTrendResult] =
    await Promise.allSettled([
      metricsApi.trend(regionId, { from, to, bucketHours }),
      metricsApi.trendForecast(regionId, { from, to, bucketHours }),
      metricsApi.stations(regionId, { from, to }),
      metricsApi.brands(regionId, { from, to }),
      metricsApi.heatmap(regionId, { from, to }),
      metricsApi.recoveryTrend(regionId, { from, to }),
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

  if (recoveryTrendResult.status === 'fulfilled') {
    recoveryTrendBuckets.value = recoveryTrendResult.value.buckets;
    sectionErrors.value.recoveryTrend = '';
  } else {
    recoveryTrendBuckets.value = [];
    sectionErrors.value.recoveryTrend = describeFailure(recoveryTrendResult);
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
        <select v-if="regions.length" v-model="selectedRegionId" @change="handleRegionChange">
          <option v-for="r in regions" :key="r._id" :value="r._id">{{ r.name }}</option>
        </select>
        <div v-else class="skeleton skeleton-select" aria-hidden="true"></div>
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
        <div class="kpi-sublabel">АИ-92, АИ-95</div>
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
      <h2>Картинка отчёта для шаринга</h2>
      <p class="hint">
        Собирает KPI, график динамики и топ-3 станции текущей вкладки (лучшие/худшие) в одну
        картинку — удобно переслать в чат вместо ссылки на отчёт.
      </p>

      <template v-if="!cardUrl">
        <button type="button" class="btn secondary" :disabled="cardGenerating" @click="generateReportCard">
          {{ cardGenerating ? 'Генерация...' : '🖼 Сгенерировать картинку' }}
        </button>
      </template>
      <template v-else>
        <img :src="cardUrl" alt="Картинка отчёта" class="card-preview" />
        <div class="card-actions">
          <button type="button" class="btn secondary" @click="resetReportCard">Сгенерировать заново</button>
          <button
            v-if="clipboardSupported"
            type="button"
            class="btn secondary"
            @click="copyReportCardToClipboard"
          >
            {{ copyFeedback === 'ok' ? 'Скопировано ✓' : 'Скопировать в буфер' }}
          </button>
          <button v-if="canShareCard" type="button" class="btn secondary" @click="shareReportCard">
            Поделиться
          </button>
          <a :href="cardUrl" download="report-card.png" class="btn">Скачать</a>
        </div>
        <p v-if="!clipboardSupported" class="hint small">
          Этот браузер не поддерживает копирование картинки в буфер обмена — скачайте файл или
          воспользуйтесь «Поделиться».
        </p>
      </template>
      <p v-if="cardError" class="error-text">{{ cardError }}</p>
    </div>

    <div class="card section">
      <div class="section-header">
        <h2>Динамика доступности <span class="hint small">(АИ-92, АИ-95)</span></h2>
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

    <div class="card section">
      <h2>Время восстановления после отключений <span class="hint small">(АИ-92, АИ-95)</span></h2>
      <p v-if="sectionErrors.recoveryTrend" class="error-text">{{ sectionErrors.recoveryTrend }}</p>
      <RecoveryTrendChart :buckets="recoveryTrendBuckets" />
      <p class="hint small">
        Среднее время от «пропало» до «появилось» по всем станциям района за день — растущий
        график значит, что топливо не только реже есть, но и дольше не появляется.
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
        <h2>Сравнение по сетям <span class="hint small">(АИ-92, АИ-95)</span></h2>
        <p v-if="sectionErrors.brands" class="error-text">{{ sectionErrors.brands }}</p>
        <BrandsChart :brands="brands" />
      </div>
    </div>

    <div class="card section">
      <h2>Доступность по дню недели и часу <span class="hint small">(АИ-92, АИ-95)</span></h2>
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
      @changed="loadMetrics"
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

/* .kpi-grid/.kpi/.kpi-value/.kpi-label moved to main.css - shared with the
   map page's current-state summary. */

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
