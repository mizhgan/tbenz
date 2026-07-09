<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import L from 'leaflet';
import { stationsApi } from '../api/regions';
import { stationMatchingApi } from '../api/stationMatching';
import { statusMeta, fuelTypeLabel } from '../utils/fuelStatus';
import { useSourceFuelRows } from '../composables/useSourceFuelRows';

const props = defineProps({
  stationId: { type: String, required: true },
});
const emit = defineEmits(['close', 'changed']);

const loading = ref(true);
const errorMessage = ref('');
const station = ref(null);
const actionError = ref('');
const actionBusy = ref(false);

const candidates = ref([]);
const candidatesLoading = ref(false);
const candidatesLoaded = ref(false);

const miniMapContainer = ref(null);
let miniMap = null;
let markersLayer = null;

// Hardcoded to gdebenz for now - this modal's "Управление источниками"
// section drives exactly one match/unmatch workflow at a time (see the
// template below); a full N-source match-management UI is a separate
// follow-up once a real 3rd source exists, not blocking the read side
// (source-summary tiles/fuel table) below, which is already fully generic.
const SOURCE_KEY = 'gdebenz';

const matchedSource = computed(() => (station.value?.sources || []).find((s) => s.key === SOURCE_KEY) || null);

// Same haversine used server-side (stationMatchingService.js) - here purely
// for display ("how far apart are the two sources' coordinates"), not for
// any matching decision.
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const sourceDistanceMeters = computed(() => {
  if (!matchedSource.value) return null;
  return Math.round(
    haversineMeters(station.value.lat, station.value.lon, matchedSource.value.lat, matchedSource.value.lon)
  );
});

// Union of every fuel type any source (tbank/each matched secondary
// source/merged) mentions, each row showing what each source itself said -
// so a disagreement (or a type only one source tracks) is visible directly,
// instead of only ever seeing the already-blended result. Shared with
// StationDetailModal.vue via composables/useSourceFuelRows.js.
const fuelRows = useSourceFuelRows(station);

async function load() {
  loading.value = true;
  errorMessage.value = '';
  try {
    station.value = await stationsApi.get(props.stationId);
  } catch (err) {
    errorMessage.value = err.response?.data?.error || 'Не удалось загрузить станцию';
  } finally {
    loading.value = false;
  }
  // loading must already be false before this - the mini-map div only
  // exists in the template's v-else-if="station" branch, which Vue won't
  // render until the "Загрузка..." (v-if="loading") branch is gone.
  if (station.value) {
    await nextTick();
    renderMap();
  }
}

function renderMap() {
  if (!miniMapContainer.value || !station.value) return;
  if (!miniMap) {
    miniMap = L.map(miniMapContainer.value, {
      zoomControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      touchZoom: false,
      boxZoom: false,
      keyboard: false,
    });
    miniMap.attributionControl.setPrefix(false);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
      crossOrigin: true,
    }).addTo(miniMap);
    markersLayer = L.layerGroup().addTo(miniMap);
  }

  markersLayer.clearLayers();
  const points = [[station.value.lat, station.value.lon]];
  L.circleMarker([station.value.lat, station.value.lon], {
    radius: 9,
    color: statusMeta(station.value.tbankLastStatus).color,
    fillColor: statusMeta(station.value.tbankLastStatus).color,
    fillOpacity: 0.9,
    weight: 2,
  })
    .bindTooltip('tbank')
    .addTo(markersLayer);

  for (const source of station.value.sources || []) {
    points.push([source.lat, source.lon]);
    L.circleMarker([source.lat, source.lon], {
      radius: 9,
      color: statusMeta(source.status).color,
      fillColor: '#fff',
      fillOpacity: 0.9,
      weight: 3,
      dashArray: '3,3',
    })
      .bindTooltip(source.label)
      .addTo(markersLayer);
  }

  if (points.length > 1) {
    miniMap.fitBounds(points, { padding: [24, 24] });
  } else {
    miniMap.setView(points[0], 15);
  }
  miniMap.invalidateSize();
}

async function loadCandidates() {
  candidatesLoading.value = true;
  actionError.value = '';
  try {
    candidates.value = await stationMatchingApi.candidatesForStation(SOURCE_KEY, props.stationId);
    candidatesLoaded.value = true;
  } catch (err) {
    actionError.value = err.response?.data?.error || 'Не удалось загрузить кандидатов';
  } finally {
    candidatesLoading.value = false;
  }
}

async function handleMatch(secondaryId) {
  actionBusy.value = true;
  actionError.value = '';
  try {
    await stationMatchingApi.match(SOURCE_KEY, secondaryId, props.stationId);
    await load();
    emit('changed');
  } catch (err) {
    actionError.value = err.response?.data?.error || 'Не удалось сопоставить станцию';
  } finally {
    actionBusy.value = false;
  }
}

async function handleUnmatch() {
  if (!matchedSource.value) return;
  if (!confirm('Отменить сопоставление? Исторические данные останутся, новые опросы перестанут объединяться.')) return;
  actionBusy.value = true;
  actionError.value = '';
  try {
    await stationMatchingApi.unmatch(SOURCE_KEY, matchedSource.value.id);
    candidatesLoaded.value = false;
    candidates.value = [];
    await load();
    emit('changed');
  } catch (err) {
    actionError.value = err.response?.data?.error || 'Не удалось отменить сопоставление';
  } finally {
    actionBusy.value = false;
  }
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('ru-RU');
}

onMounted(load);
onBeforeUnmount(() => {
  if (miniMap) miniMap.remove();
});
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop" @click.self="emit('close')">
      <div class="card modal-card">
        <div class="modal-header">
          <div>
            <h2>{{ station?.name || 'Станция' }}</h2>
            <p v-if="station?.address" class="hint">{{ station.address }}</p>
          </div>
          <button type="button" class="link-btn close-btn" @click="emit('close')">✕</button>
        </div>

        <p v-if="loading" class="hint">Загрузка...</p>
        <p v-else-if="errorMessage" class="error-text">{{ errorMessage }}</p>
        <template v-else-if="station">
          <div ref="miniMapContainer" class="mini-map"></div>
          <p v-if="sourceDistanceMeters !== null" class="hint small distance-note">
            Расстояние между координатами источников: {{ sourceDistanceMeters }} м
            <span v-if="sourceDistanceMeters > 150" class="warn-note"> — заметно далеко, стоит перепроверить сопоставление</span>
          </p>

          <h4>Статус по источникам</h4>
          <div class="source-summary" :style="{ gridTemplateColumns: `repeat(${2 + station.sources.length}, 1fr)` }">
            <div class="source-tile">
              <div class="source-label">tbank</div>
              <div class="source-value">
                <span class="badge-dot" :style="{ background: statusMeta(station.tbankLastStatus).color }"></span>
                {{ statusMeta(station.tbankLastStatus).label }}
              </div>
              <div class="hint small">Обновлено: {{ formatDate(station.tbankLastSeenAt) }}</div>
            </div>
            <div v-for="s in station.sources" :key="s.key" class="source-tile">
              <div class="source-label">{{ s.label }}</div>
              <div class="source-value">
                <span class="badge-dot" :style="{ background: statusMeta(s.status).color }"></span>
                {{ statusMeta(s.status).label }}
              </div>
              <div class="hint small">Обновлено: {{ formatDate(s.lastSeenAt) }}</div>
            </div>
            <div v-if="!station.sources.length" class="source-tile">
              <div class="source-label">Второй источник</div>
              <div class="hint small">не сопоставлено</div>
            </div>
            <div class="source-tile">
              <div class="source-label">Итог (что видят метрики/бот)</div>
              <div class="source-value">
                <span class="badge-dot" :style="{ background: statusMeta(station.lastStatus).color }"></span>
                {{ statusMeta(station.lastStatus).label }}
              </div>
              <div class="hint small">Обновлено: {{ formatDate(station.lastSeenAt) }}</div>
            </div>
          </div>

          <h4>По видам топлива</h4>
          <div class="table-wrap">
            <table class="fuel-table">
              <thead>
                <tr>
                  <th>Вид топлива</th>
                  <th>tbank</th>
                  <th v-for="s in station.sources" :key="s.key">{{ s.label }}</th>
                  <th>Итог</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in fuelRows" :key="row.fuelType">
                  <td>{{ fuelTypeLabel(row.fuelType) }}</td>
                  <td>
                    <span v-if="row.tbank" class="badge-dot" :style="{ background: statusMeta(row.tbank).color }"></span>
                    {{ row.tbank ? statusMeta(row.tbank).label : '—' }}
                  </td>
                  <td v-for="s in station.sources" :key="s.key">
                    <span
                      v-if="row.bySource[s.key]"
                      class="badge-dot"
                      :style="{ background: statusMeta(row.bySource[s.key]).color }"
                    ></span>
                    {{ row.bySource[s.key] ? statusMeta(row.bySource[s.key]).label : '—' }}
                  </td>
                  <td>
                    <span v-if="row.merged" class="badge-dot" :style="{ background: statusMeta(row.merged).color }"></span>
                    {{ row.merged ? statusMeta(row.merged).label : '—' }}
                  </td>
                </tr>
                <tr v-if="!fuelRows.length">
                  <td :colspan="3 + station.sources.length" class="hint small">
                    Нет данных по видам топлива ни от одного источника.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <h4>Управление источниками</h4>
          <p v-if="actionError" class="error-text">{{ actionError }}</p>

          <template v-if="matchedSource">
            <div class="gdebenz-info">
              <p>
                Сопоставлено с: <strong>{{ matchedSource.name || 'без названия' }}</strong>
                <span v-if="matchedSource.brand && matchedSource.brand !== matchedSource.name">
                  ({{ matchedSource.brand }})</span
                >
              </p>
              <p class="hint small">{{ matchedSource.address || 'адрес неизвестен' }}</p>
              <p v-if="matchedSource.conflict" class="hint small conflict-note">
                у {{ matchedSource.label }} есть внутреннее расхождение отчётов: «{{ matchedSource.conflict }}»
              </p>
              <p class="hint small">Обновлено: {{ formatDate(matchedSource.lastSeenAt) }}</p>
            </div>
            <button type="button" class="btn secondary" :disabled="actionBusy" @click="handleUnmatch">
              Отменить сопоставление
            </button>
          </template>

          <template v-else>
            <p class="hint">У этой станции пока нет второго источника (gdebenz).</p>
            <button
              v-if="!candidatesLoaded"
              type="button"
              class="btn secondary"
              :disabled="candidatesLoading"
              @click="loadCandidates"
            >
              {{ candidatesLoading ? 'Поиск...' : 'Найти станцию gdebenz для сопоставления' }}
            </button>
            <template v-else>
              <p v-if="!candidates.length" class="hint small">
                Рядом не нашлось несопоставленных станций gdebenz.
              </p>
              <ul v-else class="candidates">
                <li v-for="c in candidates" :key="c.secondaryId">
                  <div class="candidate-info">
                    <strong>{{ c.name || 'АЗС' }}</strong>
                    <span class="muted">{{ c.address }}</span>
                    <span class="hint small">
                      {{ c.distanceMeters }} м · схожесть названия {{ Math.round(c.nameSimilarity * 100) }}%
                    </span>
                  </div>
                  <button
                    type="button"
                    class="btn secondary"
                    :disabled="actionBusy"
                    @click="handleMatch(c.secondaryId)"
                  >
                    Это та же станция
                  </button>
                </li>
              </ul>
            </template>
          </template>
        </template>

        <div class="modal-actions">
          <button type="button" class="btn secondary" @click="emit('close')">Закрыть</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 40px 16px;
  overflow-y: auto;
  z-index: 2000;
}

.modal-card {
  width: 100%;
  max-width: 720px;
  max-height: calc(100vh - 80px);
  overflow-y: auto;
}

.modal-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.modal-header h2 {
  margin: 0 0 4px;
  font-size: 20px;
}

.close-btn {
  font-size: 18px;
  line-height: 1;
  padding: 4px 8px;
}

.mini-map {
  height: 220px;
  border-radius: 8px;
  overflow: hidden;
  margin: 12px 0 4px;
}

.distance-note {
  margin: 0 0 12px;
}

.warn-note {
  color: #b45309;
}

.hint.small {
  font-size: 12px;
  color: #64748b;
}

.source-summary {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin: 8px 0 16px;
}

.source-tile {
  padding: 10px;
  background: #f8fafc;
  border-radius: 8px;
  text-align: center;
}

.source-label {
  font-size: 11px;
  color: #64748b;
  margin-bottom: 4px;
}

.source-value {
  font-weight: 600;
}

.badge-dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  margin-right: 4px;
}

.table-wrap {
  overflow-x: auto;
}

.fuel-table {
  margin-bottom: 8px;
}

.gdebenz-info {
  margin-bottom: 8px;
}

.conflict-note {
  color: #b45309;
}

.muted {
  color: #94a3b8;
}

.candidates {
  list-style: none;
  margin: 8px 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.candidates li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  flex-wrap: wrap;
}

.candidate-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}
</style>
