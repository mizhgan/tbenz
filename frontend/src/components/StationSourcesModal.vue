<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import L from 'leaflet';
import { stationsApi } from '../api/regions';
import { stationMatchingApi } from '../api/stationMatching';
import { statusMeta, fuelTypeLabel, formatRelativeAge } from '../utils/fuelStatus';
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

// Same name/brand/address correction as StationDetailModal.vue (the public
// map card) - see that component's doc comment on why edits set
// nameEditedByAdmin/addressEditedByAdmin instead of just writing the field.
const editingDetails = ref(false);
const editForm = reactive({ name: '', brand: '', address: '' });
const editBusy = ref(false);
const editError = ref('');

function openEditDetails() {
  editForm.name = station.value?.name || '';
  editForm.brand = station.value?.brand || '';
  editForm.address = station.value?.address || '';
  editError.value = '';
  editingDetails.value = true;
}

async function saveDetails() {
  editBusy.value = true;
  editError.value = '';
  try {
    const updated = await stationsApi.update(props.stationId, {
      name: editForm.name.trim(),
      brand: editForm.brand.trim(),
      address: editForm.address.trim(),
    });
    if (station.value) Object.assign(station.value, updated);
    editingDetails.value = false;
    emit('changed');
  } catch (err) {
    editError.value = err.response?.data?.error || 'Не удалось сохранить изменения';
  } finally {
    editBusy.value = false;
  }
}

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

// Same as StationDetailModal.vue's identical computeds - see that file's
// own doc comments for the full rationale. Which secondary sources have a
// genuine per-fuel-type timestamp to show per cell (today: only alfabank).
const sourceHasPerFuelTiming = computed(() => {
  const result = {};
  for (const s of station.value?.sources || []) {
    result[s.key] = fuelRows.value.some((row) => row.bySource[s.key]?.lastTransactionAt);
  }
  return result;
});

// A column header's timestamp must be the source's *own reported
// transaction time*, not tbankLastSeenAt/s.lastSeenAt (when we happened to
// poll, regardless of whether the underlying data changed) - verified live
// that sberazs's own raw.updatedAt is identical across every station in
// the region (a whole-feed batch stamp, not per-station freshness) and
// gdebenz's payload has no timestamp field at all. Genuine source-reported
// times come in two shapes: per-fuel-type (alfabank's fuelStatuses -
// already shown per cell) and station-level (sberazs's own lastPaymentAt,
// surfaced as s.lastTransactionAt - see SberazsStation.js's doc comment) -
// this takes the freshest of whichever shape a source actually has.
const sourceHeaderTransactionAt = computed(() => {
  const result = {};
  for (const s of station.value?.sources || []) {
    const times = [...(s.fuelStatuses || []).map((f) => f.lastTransactionAt), s.lastTransactionAt]
      .filter(Boolean)
      .map((t) => new Date(t).getTime());
    result[s.key] = times.length ? new Date(Math.max(...times)) : null;
  }
  return result;
});

// "Итог"'s own timestamp is station.overallLastTransactionAt directly -
// computed server-side (see Station.js's own doc comment) at merge time,
// so no client-side recomputation needed here.

// Compact "status · relative age" table-header line - see
// StationDetailModal.vue's identical helper for the full rationale (this
// used to be a separate source-summary tile section above the table,
// repeating the same status+recency info a second time; folded into the
// header instead).
function sourceHeaderSummary(status, transactionAt) {
  const age = formatRelativeAge(transactionAt);
  return age ? `${statusMeta(status).label} · ${age}` : statusMeta(status).label;
}

// See StationDetailModal.vue's identical helper for the full rationale
// (table-header-only shortening, s.label itself untouched elsewhere).
function shortSourceLabel(label) {
  return (label || '').replace(/\.ru$/, '');
}

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
      zoomControl: true,
      dragging: true,
      scrollWheelZoom: true,
      doubleClickZoom: true,
      touchZoom: true,
      boxZoom: true,
      keyboard: true,
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
          <div v-if="station && !editingDetails">
            <h2>
              {{ station.name || 'Станция' }}
              <button type="button" class="link-btn edit-link" @click="openEditDetails">изменить</button>
            </h2>
            <p v-if="station.brand" class="hint">{{ station.brand }}</p>
            <p v-if="station.address" class="hint">{{ station.address }}</p>
          </div>
          <div v-else-if="!station">
            <h2>Станция</h2>
          </div>
          <form v-else class="edit-details-form" @submit.prevent="saveDetails">
            <div class="form-row">
              <label for="edit-name">Название</label>
              <input id="edit-name" v-model="editForm.name" type="text" />
            </div>
            <div class="form-row">
              <label for="edit-brand">Сеть</label>
              <input id="edit-brand" v-model="editForm.brand" type="text" placeholder="Например, Лукойл" />
            </div>
            <div class="form-row">
              <label for="edit-address">Адрес</label>
              <input id="edit-address" v-model="editForm.address" type="text" />
            </div>
            <p v-if="editError" class="error-text">{{ editError }}</p>
            <div class="edit-details-actions">
              <button type="button" class="btn secondary" :disabled="editBusy" @click="editingDetails = false">
                Отмена
              </button>
              <button type="submit" class="btn" :disabled="editBusy">
                {{ editBusy ? 'Сохранение...' : 'Сохранить' }}
              </button>
            </div>
          </form>
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

          <h4>По видам топлива</h4>
          <p v-if="!station.sources.length" class="hint small">Второй источник не сопоставлен.</p>
          <div class="table-wrap">
            <table class="fuel-table">
              <thead>
                <tr>
                  <th>Вид топлива</th>
                  <th>
                    <span class="source-name">
                      <span class="badge-dot" :style="{ background: statusMeta(station.tbankLastStatus).color }"></span>
                      tbank
                    </span>
                    <div
                      class="hint small header-meta"
                      :title="station.lastTransactionAt ? formatDate(station.lastTransactionAt) : null"
                    >
                      {{ sourceHeaderSummary(station.tbankLastStatus, station.lastTransactionAt) }}
                    </div>
                  </th>
                  <th v-for="s in station.sources" :key="s.key">
                    <span class="source-name">
                      <span class="badge-dot" :style="{ background: statusMeta(s.status).color }"></span>
                      {{ shortSourceLabel(s.label) }}
                    </span>
                    <div
                      class="hint small header-meta"
                      :title="
                        !sourceHasPerFuelTiming[s.key] && sourceHeaderTransactionAt[s.key]
                          ? formatDate(sourceHeaderTransactionAt[s.key])
                          : null
                      "
                    >
                      {{ sourceHeaderSummary(s.status, sourceHasPerFuelTiming[s.key] ? null : sourceHeaderTransactionAt[s.key]) }}
                    </div>
                  </th>
                  <th>
                    <span class="source-name">
                      <span class="badge-dot" :style="{ background: statusMeta(station.lastStatus).color }"></span>
                      Итог
                    </span>
                    <div
                      class="hint small header-meta"
                      :title="station.overallLastTransactionAt ? formatDate(station.overallLastTransactionAt) : null"
                    >
                      {{ sourceHeaderSummary(station.lastStatus, station.overallLastTransactionAt) }}
                    </div>
                  </th>
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
                      :style="{ background: statusMeta(row.bySource[s.key].status).color }"
                    ></span>
                    {{ row.bySource[s.key] ? statusMeta(row.bySource[s.key].status).label : '—' }}
                    <div
                      v-if="row.bySource[s.key]?.lastTransactionAt"
                      class="hint small fuel-cell-age"
                      :title="formatDate(row.bySource[s.key].lastTransactionAt)"
                    >
                      {{ formatRelativeAge(row.bySource[s.key].lastTransactionAt) }}
                    </div>
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
              <p v-if="sourceHeaderTransactionAt[SOURCE_KEY]" class="hint small">
                Обновлено: {{ formatDate(sourceHeaderTransactionAt[SOURCE_KEY]) }}
              </p>
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
  /* See StationDetailModal.vue's identical rule - lets .modal-header own
     the top inset itself so its sticky positioning pins flush. */
  padding-top: 0;
}

.modal-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  /* Pinned to the top of .modal-card's own scroll area - see
     StationDetailModal.vue's identical rule for the full rationale (name/
     address stays visible while scrolling past the fuel-type table below). */
  position: sticky;
  top: 0;
  padding: 20px 0 12px;
  margin-bottom: 12px;
  background: #fff;
  border-bottom: 1px solid #eee;
  z-index: 1;
}

.modal-header h2 {
  margin: 0 0 4px;
  font-size: 20px;
}

.edit-link {
  font-size: 12px;
  font-weight: 400;
  color: #2563eb;
  margin-left: 8px;
  vertical-align: middle;
}

.close-btn {
  font-size: 18px;
  line-height: 1;
  padding: 4px 8px;
}

.edit-details-form {
  flex: 1;
}

.edit-details-form .form-row {
  margin-bottom: 8px;
}

.edit-details-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}

.mini-map {
  height: 220px;
  border-radius: 8px;
  overflow: hidden;
  margin: 12px 0 4px;
  /* See StationDetailModal.vue's identical rule - contains Leaflet's own
     internal pane z-indices (up to 700+) so they don't leak out and paint
     over the sticky .modal-header sibling. */
  isolation: isolate;
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

.fuel-cell-age {
  white-space: nowrap;
}

.header-meta {
  font-weight: normal;
  white-space: nowrap;
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
  /* See StationDetailModal.vue's identical rule for the full rationale -
     lets the table grow past the card's own width and engage
     .table-wrap's horizontal scroll instead of squeezing a source name
     into an ugly multi-line wrap once .header-meta's own nowrap status
     line claims the space it needs. */
  width: auto;
  min-width: 100%;
}

.fuel-table th {
  font-size: 13px;
  font-weight: 500;
  padding: 8px 8px;
  white-space: nowrap;
}

.source-name {
  display: inline-flex;
  align-items: center;
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
