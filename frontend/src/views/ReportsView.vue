<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { regionsApi } from '../api/regions';
import { metricsApi } from '../api/metrics';
import { formatMinutes, formatPct } from '../utils/colorScale';
import TrendChart from '../components/TrendChart.vue';
import BrandsChart from '../components/BrandsChart.vue';
import AvailabilityHeatmap from '../components/AvailabilityHeatmap.vue';
import StationsTable from '../components/StationsTable.vue';

const route = useRoute();

const regions = ref([]);
const selectedRegionId = ref(route.query.region || '');
const loading = ref(false);
const errorMessage = ref('');

const now = Date.now();
const fromMs = ref(now - 7 * 24 * 60 * 60 * 1000);
const toMs = ref(now);

const trendBuckets = ref([]);
const forecastBuckets = ref([]);
const forecastDirection = ref('unknown');
const stations = ref([]);
const brands = ref([]);
const heatmapCells = ref([]);

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
    if (Number.isFinite(parsed)) fromMs.value = parsed;
  },
});
const toInput = computed({
  get: () => msToLocalInputValue(toMs.value),
  set: (v) => {
    const parsed = new Date(v).getTime();
    if (Number.isFinite(parsed)) toMs.value = parsed;
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

const worstStations = computed(() =>
  [...stations.value]
    .filter((s) => s.availablePct !== null)
    .sort((a, b) => a.availablePct - b.availablePct)
    .slice(0, 5)
);

async function loadRegions() {
  regions.value = await regionsApi.list();
  if (!selectedRegionId.value && regions.value.length) {
    selectedRegionId.value = regions.value[0]._id;
  }
}

async function loadMetrics() {
  if (!selectedRegionId.value) return;
  loading.value = true;
  errorMessage.value = '';
  try {
    const from = new Date(fromMs.value).toISOString();
    const to = new Date(toMs.value).toISOString();
    const bucketHours = pickBucketHours(toMs.value - fromMs.value);

    const [trendRes, forecastRes, stationsRes, brandsRes, heatmapRes] = await Promise.all([
      metricsApi.trend(selectedRegionId.value, { from, to, bucketHours }),
      metricsApi.trendForecast(selectedRegionId.value, { from, to, bucketHours }),
      metricsApi.stations(selectedRegionId.value, { from, to }),
      metricsApi.brands(selectedRegionId.value, { from, to }),
      metricsApi.heatmap(selectedRegionId.value, { from, to }),
    ]);

    trendBuckets.value = trendRes.buckets;
    forecastBuckets.value = forecastRes.forecast;
    forecastDirection.value = forecastRes.direction;
    stations.value = stationsRes.stations;
    brands.value = brandsRes.brands;
    heatmapCells.value = heatmapRes.cells;
  } catch (err) {
    errorMessage.value = err.response?.data?.error || 'Не удалось загрузить отчёт';
  } finally {
    loading.value = false;
  }
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
      <TrendChart :buckets="trendBuckets" :forecast-buckets="forecastBuckets" />
      <p class="hint small">
        Пунктир — простая линейная экстраполяция последних данных, а не точный прогноз: это
        грубая оценка направления тренда, без учёта сезонности.
      </p>
    </div>

    <div class="two-col">
      <div class="card section">
        <h2>Худшие станции</h2>
        <StationsTable :stations="worstStations" />
      </div>
      <div class="card section">
        <h2>Сравнение по сетям</h2>
        <BrandsChart :brands="brands" />
      </div>
    </div>

    <div class="card section">
      <h2>Доступность по дню недели и часу</h2>
      <AvailabilityHeatmap :cells="heatmapCells" />
    </div>

    <div class="card section">
      <h2>Все станции</h2>
      <StationsTable :stations="stations" />
    </div>
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

.hint.small {
  font-size: 12px;
}

.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

@media (max-width: 900px) {
  .two-col {
    grid-template-columns: 1fr;
  }
}
</style>
