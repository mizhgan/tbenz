<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import L from 'leaflet';
import { regionsApi } from '../api/regions';
import StationHistoryChart from '../components/StationHistoryChart.vue';
import { statusMeta } from '../utils/fuelStatus';

const route = useRoute();

const STATUS_KEYS = ['available', 'maybe_available', 'not_available', 'no_data'];

const regions = ref([]);
const selectedRegionId = ref(route.query.region || '');
const range = ref({ from: null, to: null });
const atMs = ref(Date.now());
const stations = ref([]);
const selectedStation = ref(null);
const loadingStations = ref(false);
const errorMessage = ref('');
const liveMode = ref(true);
const hasFitted = ref(false);
// Hide "no data" stations by default - by far the most common noise on the map.
const statusFilters = reactive({
  available: true,
  maybe_available: true,
  not_available: true,
  no_data: false,
});

const mapContainer = ref(null);
let map = null;
let markersLayer = null;
let liveTimer = null;
let sliderDebounceTimer = null;
let snapshotRequestId = 0;

const hasRange = computed(() => range.value.from !== null && range.value.to !== null);
const atLabel = computed(() => formatDateTime(atMs.value));
const filteredStations = computed(() =>
  stations.value.filter((s) => statusFilters[s.status] !== false)
);

function formatDateTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('ru-RU');
}

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
    renderMarkers();
  } catch (err) {
    if (requestId !== snapshotRequestId) return;
    errorMessage.value = 'Не удалось загрузить данные станций';
  } finally {
    if (requestId === snapshotRequestId) loadingStations.value = false;
  }
}

function renderMarkers() {
  if (!map) return;
  markersLayer.clearLayers();
  for (const s of filteredStations.value) {
    const meta = statusMeta(s.status);
    const marker = L.circleMarker([s.lat, s.lon], {
      radius: 7,
      color: meta.color,
      fillColor: meta.color,
      fillOpacity: 0.85,
      weight: 2,
    });
    marker.on('click', () => {
      selectedStation.value = s;
    });
    marker.bindTooltip(`${s.name || 'АЗС'} — ${meta.label}`);
    markersLayer.addLayer(marker);
  }
  if (stations.value.length && !hasFitted.value) {
    const bounds = L.latLngBounds(stations.value.map((s) => [s.lat, s.lon]));
    map.fitBounds(bounds, { padding: [30, 30] });
    hasFitted.value = true;
  }
}

function handleFilterChange() {
  renderMarkers();
}

async function handleRegionChange() {
  selectedStation.value = null;
  hasFitted.value = false;
  await loadRange();
  await loadSnapshot();
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

onMounted(async () => {
  map = L.map(mapContainer.value).setView([55.75, 37.62], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(map);
  markersLayer = L.layerGroup().addTo(map);

  await loadRegions();
  if (selectedRegionId.value) {
    await loadRange();
    await loadSnapshot();
  }

  liveTimer = setInterval(async () => {
    if (!liveMode.value || !selectedRegionId.value) return;
    await loadRange();
    await loadSnapshot();
  }, 20000);
});

onBeforeUnmount(() => {
  clearInterval(liveTimer);
  clearTimeout(sliderDebounceTimer);
  if (map) map.remove();
});
</script>

<template>
  <div class="map-page">
    <div class="controls card">
      <div class="form-row region-select">
        <label>Район</label>
        <select v-model="selectedRegionId" @change="handleRegionChange">
          <option v-for="r in regions" :key="r._id" :value="r._id">{{ r.name }}</option>
        </select>
      </div>

      <template v-if="hasRange">
        <div class="slider-block">
          <label>Момент времени: {{ atLabel }}</label>
          <input
            type="range"
            :min="range.from"
            :max="range.to"
            step="60000"
            v-model.number="atMs"
            @input="handleSliderInput"
            @change="handleSliderChange"
          />
          <div class="slider-labels">
            <span>{{ formatDateTime(range.from) }}</span>
            <span>{{ formatDateTime(range.to) }}</span>
          </div>
        </div>
        <button class="btn secondary" :class="{ active: liveMode }" @click="jumpToNow">
          {{ liveMode ? '● Живой режим' : 'К текущему моменту' }}
        </button>
      </template>
      <p v-else class="hint">
        Для этого района ещё нет исторических данных. Опросите его на странице «Районы».
      </p>

      <div v-if="hasRange" class="filter-block">
        <span class="filter-label">Показывать:</span>
        <label v-for="key in STATUS_KEYS" :key="key" class="filter-checkbox">
          <input type="checkbox" v-model="statusFilters[key]" @change="handleFilterChange" />
          <span class="dot" :style="{ background: statusMeta(key).color }"></span>
          {{ statusMeta(key).label }}
        </label>
      </div>
    </div>

    <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>

    <div class="map-body">
      <div ref="mapContainer" class="leaflet-map"></div>

      <div class="sidebar card">
        <div v-if="!selectedStation">
          <p class="hint">Кликните по станции на карте, чтобы увидеть детали и историю.</p>
          <p class="hint">Показано станций: {{ filteredStations.length }} из {{ stations.length }}</p>
        </div>
        <div v-else>
          <h3>{{ selectedStation.name || 'АЗС' }}</h3>
          <p v-if="selectedStation.address">{{ selectedStation.address }}</p>
          <p>
            <span class="badge-dot" :style="{ background: statusMeta(selectedStation.status).color }"></span>
            {{ statusMeta(selectedStation.status).label }}
          </p>
          <ul class="fuel-list">
            <li v-for="f in selectedStation.fuelStatuses" :key="f.fuelType">
              <strong>АИ-{{ f.fuelType }}</strong>
              <span class="badge-dot" :style="{ background: statusMeta(f.status).color }"></span>
              {{ statusMeta(f.status).label }}
            </li>
          </ul>
          <p class="hint">
            Последняя транзакция:
            {{ selectedStation.lastTransactionAt ? formatDateTime(new Date(selectedStation.lastTransactionAt).getTime()) : 'нет данных' }}
          </p>
          <p class="hint">Снимок на момент: {{ formatDateTime(new Date(selectedStation.polledAt).getTime()) }}</p>
          <h4>История по видам топлива</h4>
          <StationHistoryChart :station-id="selectedStation.stationId" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.map-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.controls {
  display: flex;
  align-items: center;
  gap: 24px;
  flex-wrap: wrap;
}

.region-select select {
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid #ccd2d9;
  min-width: 220px;
}

.slider-block {
  flex: 1;
  min-width: 280px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.slider-block input[type='range'] {
  width: 100%;
}

.slider-labels {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: #667;
}

.btn.secondary.active {
  background: #dbeafe;
  color: #1d4ed8;
}

.map-body {
  display: flex;
  gap: 16px;
  align-items: stretch;
}

.leaflet-map {
  flex: 1;
  min-height: 560px;
  border-radius: 10px;
  overflow: hidden;
}

.sidebar {
  width: 340px;
  flex-shrink: 0;
}

.fuel-list {
  list-style: none;
  padding: 0;
  margin: 8px 0;
}

.fuel-list li {
  padding: 4px 0;
  border-bottom: 1px solid #eee;
  display: flex;
  align-items: center;
  gap: 6px;
}

.filter-block {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  width: 100%;
  padding-top: 4px;
  border-top: 1px solid #eee;
}

.filter-label {
  font-size: 13px;
  color: #667;
}

.filter-checkbox {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #445;
  cursor: pointer;
}

.dot,
.badge-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
}
</style>
