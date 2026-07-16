<script setup>
import { onMounted, reactive, ref, watch } from 'vue';
import { regionsApi, stationsApi } from '../api/regions';
import { statusMeta } from '../utils/fuelStatus';
import StationSourcesModal from '../components/StationSourcesModal.vue';

const STATUS_OPTIONS = [
  { value: '', label: 'Любой статус' },
  { value: 'available', label: 'Есть' },
  { value: 'maybe_available', label: 'Возможно есть' },
  { value: 'not_available', label: 'Нет' },
  { value: 'no_data', label: 'Нет данных' },
];

const MATCH_STATE_OPTIONS = [
  { value: '', label: 'Любые' },
  { value: 'matched', label: 'Есть второй источник' },
  { value: 'unmatched', label: 'Без второго источника' },
];

const regions = ref([]);
const stations = ref([]);
const loading = ref(true);
const errorMessage = ref('');

const filters = reactive({
  q: '',
  region: '',
  status: '',
  matchState: '',
});

let searchDebounceTimer = null;

async function loadRegions() {
  try {
    regions.value = await regionsApi.list();
  } catch (err) {
    // Non-fatal - the region filter just stays empty if this fails.
  }
}

async function loadStations() {
  loading.value = true;
  errorMessage.value = '';
  try {
    const params = { limit: 300 };
    if (filters.q.trim()) params.q = filters.q.trim();
    if (filters.region) params.region = filters.region;
    if (filters.status) params.status = filters.status;
    if (filters.matchState) params.matchState = filters.matchState;
    stations.value = await stationsApi.list(params);
  } catch (err) {
    errorMessage.value = err.response?.data?.error || 'Не удалось загрузить список станций';
  } finally {
    loading.value = false;
  }
}

function handleTextInput() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(loadStations, 300);
}

watch(() => [filters.region, filters.status, filters.matchState], loadStations);

function regionNames(station) {
  if (!station.regions?.length) return '—';
  return station.regions
    .map((rid) => regions.value.find((r) => r._id === String(rid))?.name)
    .filter(Boolean)
    .join(', ') || '—';
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('ru-RU');
}

const selectedStationId = ref(null);

function openDetail(station) {
  selectedStationId.value = station._id;
}

function closeDetail() {
  selectedStationId.value = null;
}

function handleChanged() {
  // A match/unmatch inside the detail modal can change this station's
  // sourceLinks, which the matchState filter here depends on - refresh so
  // the list stays consistent with what the modal just did.
  loadStations();
}

onMounted(async () => {
  await loadRegions();
  await loadStations();
});
</script>

<template>
  <div>
    <div class="page-header">
      <h1>Станции</h1>
      <button class="btn secondary" :disabled="loading" @click="loadStations">Обновить</button>
    </div>

    <div class="card controls">
      <div class="form-row">
        <label>Поиск</label>
        <input v-model="filters.q" type="text" placeholder="Название или адрес" @input="handleTextInput" />
      </div>
      <div class="form-row">
        <label>Район</label>
        <select v-model="filters.region">
          <option value="">Все районы</option>
          <option v-for="r in regions" :key="r._id" :value="r._id">{{ r.name }}</option>
        </select>
      </div>
      <div class="form-row">
        <label>Статус</label>
        <select v-model="filters.status">
          <option v-for="opt in STATUS_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
      </div>
      <div class="form-row">
        <label>Источники</label>
        <select v-model="filters.matchState">
          <option v-for="opt in MATCH_STATE_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
      </div>
    </div>

    <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>

    <div class="card">
      <p v-if="loading">Загрузка...</p>
      <p v-else-if="!stations.length">Станции не найдены по заданным фильтрам.</p>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Станция</th>
              <th>Район(ы)</th>
              <th>Статус</th>
              <th>Источники</th>
              <th>Последний опрос</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in stations" :key="s._id" class="clickable-row" @click="openDetail(s)">
              <td>
                <strong>{{ s.name || 'АЗС' }}</strong>
                <div class="hint small">{{ s.address || '—' }}</div>
              </td>
              <td>{{ regionNames(s) }}</td>
              <td>
                <span class="badge-dot" :style="{ background: statusMeta(s.lastStatus).color }"></span>
                {{ statusMeta(s.lastStatus).label }}
              </td>
              <td>
                tbank<span v-for="l in s.sourceLinks || []" :key="l.sourceKey"> + {{ l.sourceKey }}</span>
              </td>
              <td class="hint small">{{ formatDate(s.lastSeenAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <StationSourcesModal
      v-if="selectedStationId"
      :station-id="selectedStationId"
      @close="closeDetail"
      @changed="handleChanged"
    />
  </div>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.page-header h1 {
  font-size: 20px;
  margin: 0;
}

.controls {
  display: flex;
  align-items: flex-end;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.controls .form-row {
  margin-bottom: 0;
  min-width: 180px;
}

.hint.small {
  font-size: 12px;
  color: #64748b;
}

.badge-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-right: 4px;
}

.table-wrap {
  overflow-x: auto;
}

.clickable-row {
  cursor: pointer;
}

.clickable-row:hover {
  background: #f8fafc;
}

[data-theme='dark'] .clickable-row:hover {
  background: #1e293b;
}
</style>
