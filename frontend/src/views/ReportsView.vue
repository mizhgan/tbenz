<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { regionsApi, stationsApi } from '../api/regions';
import { metricsApi } from '../api/metrics';
import { formatMinutes, formatPct, bucketPeriodLabel } from '../utils/colorScale';
import { computeStatusSegments, collapseIsolatedBlips } from '../utils/fuelStatus';
import { renderRegionReportCard } from '../utils/regionReportCard';
import { canCopyImageToClipboard } from '../utils/stationCard';
import { canShareFile } from '../utils/mapExport';
import TrendChart from '../components/TrendChart.vue';
import RecoveryTrendChart from '../components/RecoveryTrendChart.vue';
import BrandsChart from '../components/BrandsChart.vue';
import AvailabilityHeatmap from '../components/AvailabilityHeatmap.vue';
import StationHighlightCards from '../components/StationHighlightCards.vue';
import StationsTable from '../components/StationsTable.vue';
import StationDetailModal from '../components/StationDetailModal.vue';
import { useAsyncAction } from '../composables/useAsyncAction';

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
// Not useKeyedAsyncAction's Set - only one detail fetch is ever really in
// flight (one click opens one modal), and the child tables' :loading-
// station-id prop wants the specific id, not a has()-checkable collection.
const detailLoadingId = ref(null);
const { error: detailError, run: runOpenDetail } = useAsyncAction();

async function openStationDetail(stationId) {
  detailLoadingId.value = stationId;
  const doc = await runOpenDetail(() => stationsApi.get(stationId), { fallbackMessage: 'Не удалось загрузить данные станции' });
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

const now = Date.now();
const fromMs = ref(now - 7 * 24 * 60 * 60 * 1000);
const toMs = ref(now);
// Exposed as their own computed properties (not just local vars inside
// loadMetrics) so the template can pass the page's actual selected period
// down to StationHighlightCards' ribbons too - those used to always show a
// fixed last-7-days regardless of what period was picked here.
const fromIso = computed(() => new Date(fromMs.value).toISOString());
const toIso = computed(() => new Date(toMs.value).toISOString());
// Single source of truth for the period's chosen bucket size - loadMetrics
// uses it for every bucketed API call, RecoveryTrendChart.vue and the hint
// text below it use it to phrase "за день"/"за неделю" instead of each
// guessing independently (see bucketPeriodLabel's own doc comment).
const bucketHours = computed(() => pickBucketHours(toMs.value - fromMs.value));

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

// Daily threshold raised from 14 to 90 days - at 14, a 30-day report (the
// widest preset button) fell into weekly buckets and rendered as ~5 points,
// most of the "Динамика доступности" chart empty past that. Chart.js
// already auto-thins x-axis labels regardless of point count (see
// TrendChart.vue), so 90 daily points renders fine - no need for a fancier
// adaptive scheme, just moving the cliff somewhere the still-fixed 30/7/90
// preset buttons don't land right on top of it.
function pickBucketHours(spanMs) {
  const spanHours = spanMs / 3600000;
  if (spanHours <= 48) return 1;
  if (spanHours <= 24 * 90) return 24;
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

// Sorted/selected by rankScore (shrunk toward the region's own rate, so a
// station with barely any evidence this period can't win "лучшая"/"худшая"
// purely on a lucky or unlucky small sample), but every printed
// availablePct stays the plain, unshrunk rate - see metricsService.js's
// getStationMetricsUncached for the full rationale (reported live: a
// station with zero interruptions the whole period was printing less than
// 100%, which reads as a bug, not a nuance, since a reader has no way to
// know the number they're looking at was silently adjusted).
const highlightedStations = computed(() => {
  const dir = stationsSort.value === 'best' ? -1 : 1;
  return [...stations.value]
    .filter((s) => s.rankScore !== null)
    .sort((a, b) => dir * (a.rankScore - b.rankScore))
    .slice(0, 5);
});

const selectedRegion = computed(() => regions.value.find((r) => r._id === selectedRegionId.value) || null);

// Shareable report card - client-side canvas, same approach and UI pattern
// (generate -> preview -> copy/download/share) as the station card in
// StationDetailModal.vue.
const cardUrl = ref(null);
const copyFeedback = ref('');
// Shared across generateReportCard/copyReportCardToClipboard/shareReportCard
// below - see StationDetailModal.vue's identical grouping/rationale for its
// own card flow.
const { loading: cardGenerating, error: cardError, run: runCard } = useAsyncAction();
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
  copyFeedback.value = '';
  await runCard(
    async () => {
      const topStationsBase = highlightedStations.value.slice(0, 3);
      // Best-of (default CORE_FUEL_TYPES) ribbon per top station, same real
      // segments (not bucketed) StationReliabilityTimeline.vue itself draws -
      // fetched here rather than inside regionReportCard.js since that file
      // is a pure Canvas layout function with no API access of its own (same
      // pattern generateCard() in StationDetailModal.vue already follows for
      // its own card's history). Only 3 stations, so 3 parallel fetches.
      const historyResults = await Promise.allSettled(
        topStationsBase.map((s) => stationsApi.history(s.stationId, { from: fromIso.value, to: toIso.value, limit: 5000 }))
      );
      const topStations = topStationsBase.map((s, i) => {
        const result = historyResults[i];
        const history = result.status === 'fulfilled' ? result.value : [];
        const ribbon = history.length ? collapseIsolatedBlips(computeStatusSegments(history)) : [];
        return {
          ...s,
          ribbon,
          ribbonRangeStart: history.length ? history[0].polledAt : null,
          ribbonRangeEnd: history.length ? history[history.length - 1].polledAt : null,
        };
      });

      const blob = await renderRegionReportCard({
        region: selectedRegion.value || { name: 'Район' },
        from: fromMs.value,
        to: toMs.value,
        summary: summary.value,
        trendBuckets: trendBuckets.value,
        forecastBuckets: forecastBuckets.value,
        recoveryTrendBuckets: recoveryTrendBuckets.value,
        direction: forecastDirection.value,
        topStations,
        stationsLabel: stationsSort.value === 'best' ? 'Лучшие станции' : 'Худшие станции',
      });
      if (cardUrl.value) URL.revokeObjectURL(cardUrl.value);
      cardBlob = blob;
      cardUrl.value = URL.createObjectURL(blob);
      const safeName = (selectedRegion.value?.name || 'region').replace(/[^\p{L}\p{N}]+/gu, '-');
      cardFile = new File([blob], `${safeName}-report.png`, { type: 'image/png' });
    },
    { formatError: (err) => `Не удалось создать картинку: ${err.message || 'неизвестная ошибка'}` }
  );
}

async function copyReportCardToClipboard() {
  if (!cardBlob) return;
  copyFeedback.value = '';
  const result = await runCard(() => navigator.clipboard.write([new ClipboardItem({ 'image/png': cardBlob })]), {
    formatError: (err) => `Не удалось скопировать: ${err.message || 'неизвестная ошибка'}`,
  });
  copyFeedback.value = result !== undefined ? 'ok' : 'error';
}

async function shareReportCard() {
  if (!cardFile) return;
  await runCard(
    () => navigator.share({ files: [cardFile], title: `Отчёт: ${selectedRegion.value?.name || 'Район'}` }),
    {
      formatError: (err) => (err.name === 'AbortError' ? null : `Не удалось поделиться: ${err.message || 'неизвестная ошибка'}`),
    }
  );
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
  const from = fromIso.value;
  const to = toIso.value;

  const [trendResult, forecastResult, stationsResult, brandsResult, heatmapResult, recoveryTrendResult] =
    await Promise.allSettled([
      metricsApi.trend(regionId, { from, to, bucketHours: bucketHours.value }),
      metricsApi.trendForecast(regionId, { from, to, bucketHours: bucketHours.value }),
      metricsApi.stations(regionId, { from, to }),
      metricsApi.brands(regionId, { from, to }),
      metricsApi.heatmap(regionId, { from, to }),
      metricsApi.recoveryTrend(regionId, { from, to, bucketHours: bucketHours.value }),
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
        <button class="btn secondary" @click="setPreset(24 * 90)">90д</button>
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
        Собирает KPI, графики динамики и времени восстановления, топ-3 станции текущей вкладки
        (лучшие/худшие) в одну картинку — удобно переслать в чат вместо ссылки на отчёт.
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
      <RecoveryTrendChart :buckets="recoveryTrendBuckets" :bucket-hours="bucketHours" />
      <p class="hint small">
        Среднее время от «пропало» до «появилось» по всем станциям района {{ bucketPeriodLabel(bucketHours) }} —
        растущий график значит, что топливо не только реже есть, но и дольше не появляется.
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
        <StationHighlightCards
          :stations="highlightedStations"
          :loading-station-id="detailLoadingId"
          :from="fromIso"
          :to="toIso"
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
   than their content's intrinsic size - without this, the wider of the two
   cards (station cards with ribbons, or the brands chart) would drag the
   whole page into horizontal scroll on a narrow viewport instead of each
   card's own overflow handling taking over. */
.two-col > * {
  min-width: 0;
}

@media (max-width: 900px) {
  .two-col {
    grid-template-columns: 1fr;
  }
}

/* Site dark theme (store/theme.js) - this file's own .region-select border
   and .sort-toggle active state otherwise tie in specificity with
   main.css's generic dark rules and can win on source order alone. */
[data-theme='dark'] .region-select select {
  background: #1e293b;
  color: #e2e8f0;
  border-color: #334155;
}

[data-theme='dark'] .sort-toggle .btn.active {
  background: #1e3a5f;
  color: #93c5fd;
}
</style>
