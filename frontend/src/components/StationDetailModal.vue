<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import L from 'leaflet';
import { stationsApi } from '../api/regions';
import { statusMeta, fuelTypeLabel, formatRelativeAge, bestFuelStatus } from '../utils/fuelStatus';
import { availabilityColor, formatPct, formatMinutes } from '../utils/colorScale';
import { renderStationCard, canCopyImageToClipboard } from '../utils/stationCard';
import { canShareFile } from '../utils/mapExport';
import { useSourceFuelRows } from '../composables/useSourceFuelRows';
import { useAuthStore } from '../store/auth';
import StationReliabilityTimeline from './StationReliabilityTimeline.vue';

const props = defineProps({
  station: { type: Object, required: true },
  regionId: { type: String, required: true },
  selectedFuelTypes: { type: Array, default: () => [] },
});
const emit = defineEmits(['close', 'changed']);

// This modal is reachable from the public map/reports pages (unlike
// StationSourcesModal.vue, which only ever renders behind the already
// admin-gated /stations route) - PUT /stations/:id is admin-only server
// side regardless, but showing a viewer an "изменить" link that would just
// 403 on submit is misleading, so it's hidden for them entirely instead.
const auth = useAuthStore();

// The badge/mini-map marker's own status - best-of among whatever fuel
// types the map had selected when this modal was opened (props.selectedFuelTypes,
// same set driving that marker's own color), falling back to gasoline
// (bestFuelStatus's own CORE_FUEL_TYPES default) when opened without that
// context. NOT the station's blanket `status` field - that's an
// independent per-source vote across every fuel type a station sells (see
// mergeStatusService.js's own doc comment) and can disagree with the
// gasoline-only picture the rest of the app already shows - confirmed
// live: a station read green on the map but orange here, because this
// badge was reading that blanket field instead of this.
const badgeStatus = computed(() =>
  bestFuelStatus(props.station.fuelStatuses, props.selectedFuelTypes.length ? props.selectedFuelTypes : undefined)
);

const miniMapContainer = ref(null);
let miniMap = null;

const reliabilityLoading = ref(true);
const reliabilityError = ref('');
const reliability = ref(null);

// Per-source breakdown (tbank vs gdebenz vs the merged result this whole
// modal otherwise shows) - fetched separately from the same GET /stations/:id
// the admin station-sources view uses, since the snapshot this modal's
// `station` prop is built from (MapView/ReportsView) only ever carries the
// already-merged status.
const sourcesLoading = ref(true);
const sourcesError = ref('');
const sourceDoc = ref(null);

// Union of every fuel type any source (tbank/each matched secondary
// source/merged) mentions, each row showing what each source itself said -
// shared with StationSourcesModal.vue via composables/useSourceFuelRows.js.
const sourceFuelRows = useSourceFuelRows(sourceDoc);

// Which secondary sources actually have a genuine per-fuel-type timestamp
// to show per cell (today: only alfabank - see useSourceFuelRows.js's
// resolveSourceFuelReading) - the rest have nothing to put in their own
// table cells.
const sourceHasPerFuelTiming = computed(() => {
  const result = {};
  for (const s of sourceDoc.value?.sources || []) {
    result[s.key] = sourceFuelRows.value.some((row) => row.bySource[s.key]?.lastTransactionAt);
  }
  return result;
});

// Any "when was this actually current" timestamp shown for a source (the
// table's own column header, folded together with its status via
// sourceHeaderSummary below - a source-summary tile section used to repeat
// this same info above the table, since removed) must be *the source's own
// reported transaction time*, not tbankLastSeenAt/s.lastSeenAt (when we
// happened to poll - the same regardless of whether the underlying data
// changed at all, so printing it read as "when did the data come from" but
// actually meant "when did we last ask"). Verified live: sberazs's own
// raw.updatedAt was identical across every single station in the region -
// a whole-feed batch timestamp, not per-station freshness - and gdebenz's
// payload has no timestamp field of any kind. Genuine source-reported
// times come in two shapes: per-fuel-type (alfabank's fuelStatuses -
// already shown per cell in the table) and station-level (sberazs's own
// lastPaymentAt, surfaced as s.lastTransactionAt by GET /stations/:id -
// see SberazsStation.js's doc comment) - this takes the freshest of
// whichever shape a given source actually has, so gdebenz (neither)
// correctly shows nothing.
const sourceHeaderTransactionAt = computed(() => {
  const result = {};
  for (const s of sourceDoc.value?.sources || []) {
    const times = [...(s.fuelStatuses || []).map((f) => f.lastTransactionAt), s.lastTransactionAt]
      .filter(Boolean)
      .map((t) => new Date(t).getTime());
    result[s.key] = times.length ? new Date(Math.max(...times)) : null;
  }
  return result;
});


// Compact "status · relative age" table-header line - replaces what used
// to be two separate widgets (the source-summary tiles above the table,
// and the table's own header subtitle) showing the same status+recency
// info about each source twice. `transactionAt` is deliberately nullable
// (gdebenz has no genuine transaction time at all, and a source with its
// own per-cell timing - alfabank - passes null here on purpose so its
// header doesn't repeat what every row already shows) - the status half
// always renders regardless, since every source always has *some* status.
function sourceHeaderSummary(status, transactionAt) {
  const age = formatRelativeAge(transactionAt);
  return age ? `${statusMeta(status).label} · ${age}` : statusMeta(status).label;
}

async function loadSources() {
  sourcesLoading.value = true;
  sourcesError.value = '';
  try {
    sourceDoc.value = await stationsApi.get(props.station.stationId);
  } catch (err) {
    sourcesError.value = 'Не удалось загрузить сведения об источниках';
  } finally {
    sourcesLoading.value = false;
  }
}

// The header shows sourceDoc's name/brand/address once loaded (the full
// Station document, including brand - which the map/reports snapshot the
// `station` prop is built from doesn't carry at all) instead of the prop
// directly, so an edit (see below) and tbank's own future corrections are
// both reflected without waiting on the parent to refresh its own list.
// Falls back to the prop only for the brief window before loadSources
// resolves.
const headerStation = computed(() => ({
  name: sourceDoc.value?.name ?? props.station.name,
  brand: sourceDoc.value?.brand ?? null,
  address: sourceDoc.value?.address ?? props.station.address,
}));

const editingDetails = ref(false);
const editForm = reactive({ name: '', brand: '', address: '' });
const editBusy = ref(false);
const editError = ref('');

function openEditDetails() {
  editForm.name = headerStation.value.name || '';
  editForm.brand = headerStation.value.brand || '';
  editForm.address = headerStation.value.address || '';
  editError.value = '';
  editingDetails.value = true;
}

async function saveDetails() {
  editBusy.value = true;
  editError.value = '';
  try {
    const updated = await stationsApi.update(props.station.stationId, {
      name: editForm.name.trim(),
      brand: editForm.brand.trim(),
      address: editForm.address.trim(),
    });
    if (sourceDoc.value) Object.assign(sourceDoc.value, updated);
    editingDetails.value = false;
    emit('changed');
  } catch (err) {
    editError.value = err.response?.data?.error || 'Не удалось сохранить изменения';
  } finally {
    editBusy.value = false;
  }
}

const cardGenerating = ref(false);
const cardUrl = ref(null);
const cardError = ref('');
const copyFeedback = ref('');
const clipboardSupported = canCopyImageToClipboard();
let cardBlob = null;
let cardFile = null;
const canShareCard = computed(() => !!cardFile && canShareFile(cardFile));

function formatDateTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('ru-RU');
}

async function loadReliability() {
  reliabilityLoading.value = true;
  reliabilityError.value = '';
  try {
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 3600 * 1000);
    // Scoped to just this one station (see stations.controller.js's
    // getStationReliability doc comment) - this used to call the
    // region-wide /metrics/stations endpoint just to pick one entry out of
    // it, computing all ~100 other stations' history for nothing every
    // time this modal opened.
    const { reliability: result } = await stationsApi.reliability(props.station.stationId, {
      from: from.toISOString(),
      to: to.toISOString(),
    });
    reliability.value = result;
  } catch (err) {
    reliabilityError.value = 'Не удалось загрузить статистику надёжности';
  } finally {
    reliabilityLoading.value = false;
  }
}

function resetCard() {
  if (cardUrl.value) {
    URL.revokeObjectURL(cardUrl.value);
    cardUrl.value = null;
  }
  cardBlob = null;
  cardFile = null;
  cardError.value = '';
  copyFeedback.value = '';
}

async function generateCard() {
  cardError.value = '';
  copyFeedback.value = '';
  cardGenerating.value = true;
  try {
    // Forecast/history are "nice to have" on the card, not essential - a
    // failure on either just means that section is omitted, not that the
    // whole card generation fails (same reasoning as the reports page's
    // per-section error handling).
    // from/limit matches StationReliabilityTimeline.vue's own request - the
    // card's status ribbon needs the same real 7 days of history the live
    // page's ribbon shows, not just whatever the fuel-type strips below it
    // used to get by with (200 most recent, unbounded span - often well
    // under a week at ~15-minute polling).
    const historyFrom = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const [forecastResult, historyResult] = await Promise.allSettled([
      stationsApi.forecast(props.station.stationId, { hoursAhead: 12 }),
      stationsApi.history(props.station.stationId, { from: historyFrom, limit: 5000 }),
    ]);
    const forecast = forecastResult.status === 'fulfilled' ? forecastResult.value : null;
    const history = historyResult.status === 'fulfilled' ? historyResult.value : null;

    // Merges in headerStation's name/address rather than using the prop
    // as-is, so a correction made in this same modal session (see
    // saveDetails above) shows up on a card generated right after, instead
    // of the stale value the parent's snapshot/table still has until its
    // own next refresh.
    const blob = await renderStationCard({
      station: { ...props.station, name: headerStation.value.name, address: headerStation.value.address },
      reliability: reliability.value,
      forecast,
      history,
    });
    if (cardUrl.value) URL.revokeObjectURL(cardUrl.value);
    cardBlob = blob;
    cardUrl.value = URL.createObjectURL(blob);
    const safeName = (headerStation.value.name || 'station').replace(/[^\p{L}\p{N}]+/gu, '-');
    cardFile = new File([blob], `${safeName}-card.png`, { type: 'image/png' });
  } catch (err) {
    cardError.value = `Не удалось создать картинку: ${err.message || 'неизвестная ошибка'}`;
  } finally {
    cardGenerating.value = false;
  }
}

async function copyCardToClipboard() {
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

async function shareCard() {
  if (!cardFile) return;
  try {
    await navigator.share({ files: [cardFile], title: `Статус станции: ${headerStation.value.name || 'АЗС'}` });
  } catch (err) {
    if (err.name !== 'AbortError') {
      cardError.value = `Не удалось поделиться: ${err.message || 'неизвестная ошибка'}`;
    }
  }
}

onMounted(async () => {
  loadReliability();
  loadSources();

  await nextTick();
  // Interactive (unlike StationSourcesModal's mini-map, which stays a fixed
  // static preview) - a station's neighbors can be close together, and a
  // fixed zoom level sometimes isn't enough to tell which pin is actually
  // this station.
  miniMap = L.map(miniMapContainer.value, {
    zoomControl: true,
    dragging: true,
    scrollWheelZoom: true,
    doubleClickZoom: true,
    touchZoom: true,
    boxZoom: true,
    keyboard: true,
  }).setView([props.station.lat, props.station.lon], 15);
  miniMap.attributionControl.setPrefix(false);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
    crossOrigin: true,
  }).addTo(miniMap);
  L.circleMarker([props.station.lat, props.station.lon], {
    radius: 8,
    color: statusMeta(badgeStatus.value).color,
    fillColor: statusMeta(badgeStatus.value).color,
    fillOpacity: 0.9,
    weight: 2,
  }).addTo(miniMap);
  miniMap.invalidateSize();
});

onBeforeUnmount(() => {
  if (miniMap) miniMap.remove();
  if (cardUrl.value) URL.revokeObjectURL(cardUrl.value);
});
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop" @click.self="emit('close')">
      <div class="card modal-card">
        <div class="modal-header">
          <div v-if="!editingDetails">
            <h2>
              {{ headerStation.name || 'АЗС' }}
              <button v-if="auth.isAdmin" type="button" class="link-btn edit-link" @click="openEditDetails">
                изменить
              </button>
            </h2>
            <p v-if="headerStation.brand" class="hint">{{ headerStation.brand }}</p>
            <p v-if="headerStation.address" class="hint">{{ headerStation.address }}</p>
          </div>
          <form v-else-if="auth.isAdmin" class="edit-details-form" @submit.prevent="saveDetails">
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

        <p>
          <span class="badge-dot" :style="{ background: statusMeta(badgeStatus).color }"></span>
          {{ statusMeta(badgeStatus).label }}
        </p>

        <div ref="miniMapContainer" class="mini-map"></div>

        <h4>Виды топлива</h4>
        <ul class="fuel-list">
          <li
            v-for="f in station.fuelStatuses"
            :key="f.fuelType"
            :class="{ 'fuel-list-active': selectedFuelTypes.includes(f.fuelType) }"
          >
            <strong>{{ fuelTypeLabel(f.fuelType) }}</strong>
            <span class="badge-dot" :style="{ background: statusMeta(f.status).color }"></span>
            {{ statusMeta(f.status).label }}
          </li>
        </ul>

        <p class="hint">
          Последняя транзакция:
          {{
            station.overallLastTransactionAt
              ? formatDateTime(new Date(station.overallLastTransactionAt).getTime())
              : 'нет данных'
          }}
        </p>
        <p class="hint">Снимок на момент: {{ formatDateTime(new Date(station.polledAt).getTime()) }}</p>

        <h4>Источники данных</h4>
        <p v-if="sourcesLoading" class="hint">Загрузка...</p>
        <p v-else-if="sourcesError" class="error-text">{{ sourcesError }}</p>
        <template v-else-if="sourceDoc">
          <p v-if="!sourceDoc.sources.length" class="hint small">Второй источник не сопоставлен.</p>

          <div class="table-wrap">
            <table class="fuel-table">
              <thead>
                <tr>
                  <th>Вид топлива</th>
                  <th>
                    <span class="badge-dot" :style="{ background: statusMeta(sourceDoc.tbankLastStatus).color }"></span>
                    tbank
                    <div
                      class="hint small header-meta"
                      :title="sourceDoc.lastTransactionAt ? formatDateTime(sourceDoc.lastTransactionAt) : null"
                    >
                      {{ sourceHeaderSummary(sourceDoc.tbankLastStatus, sourceDoc.lastTransactionAt) }}
                    </div>
                  </th>
                  <th v-for="s in sourceDoc.sources" :key="s.key">
                    <span class="badge-dot" :style="{ background: statusMeta(s.status).color }"></span>
                    {{ s.label }}
                    <div
                      class="hint small header-meta"
                      :title="
                        !sourceHasPerFuelTiming[s.key] && sourceHeaderTransactionAt[s.key]
                          ? formatDateTime(sourceHeaderTransactionAt[s.key])
                          : null
                      "
                    >
                      {{ sourceHeaderSummary(s.status, sourceHasPerFuelTiming[s.key] ? null : sourceHeaderTransactionAt[s.key]) }}
                    </div>
                  </th>
                  <th>
                    <span class="badge-dot" :style="{ background: statusMeta(sourceDoc.lastStatus).color }"></span>
                    Итог
                    <div
                      class="hint small header-meta"
                      :title="sourceDoc.overallLastTransactionAt ? formatDateTime(sourceDoc.overallLastTransactionAt) : null"
                    >
                      {{ sourceHeaderSummary(sourceDoc.lastStatus, sourceDoc.overallLastTransactionAt) }}
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in sourceFuelRows" :key="row.fuelType">
                  <td>{{ fuelTypeLabel(row.fuelType) }}</td>
                  <td>
                    <span v-if="row.tbank" class="badge-dot" :style="{ background: statusMeta(row.tbank).color }"></span>
                    {{ row.tbank ? statusMeta(row.tbank).label : '—' }}
                  </td>
                  <td v-for="s in sourceDoc.sources" :key="s.key">
                    <span
                      v-if="row.bySource[s.key]"
                      class="badge-dot"
                      :style="{ background: statusMeta(row.bySource[s.key].status).color }"
                    ></span>
                    {{ row.bySource[s.key] ? statusMeta(row.bySource[s.key].status).label : '—' }}
                    <div
                      v-if="row.bySource[s.key]?.lastTransactionAt"
                      class="hint small fuel-cell-age"
                      :title="formatDateTime(row.bySource[s.key].lastTransactionAt)"
                    >
                      {{ formatRelativeAge(row.bySource[s.key].lastTransactionAt) }}
                    </div>
                  </td>
                  <td>
                    <span v-if="row.merged" class="badge-dot" :style="{ background: statusMeta(row.merged).color }"></span>
                    {{ row.merged ? statusMeta(row.merged).label : '—' }}
                  </td>
                </tr>
                <tr v-if="!sourceFuelRows.length">
                  <td :colspan="3 + sourceDoc.sources.length" class="hint small">
                    Нет данных по видам топлива ни от одного источника.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-if="!sourceDoc.sources.length" class="hint small">
            У этой станции пока нет других источников для сверки.
          </p>
        </template>

        <h4>Надёжность за последние 7 дней</h4>
        <p v-if="reliabilityLoading" class="hint">Загрузка...</p>
        <p v-else-if="reliabilityError" class="error-text">{{ reliabilityError }}</p>
        <p v-else-if="!reliability" class="hint">Недостаточно данных за этот период.</p>
        <div v-else class="reliability-grid">
          <div class="reliability-tile">
            <span class="reliability-value" :style="{ color: availabilityColor(reliability.availablePct) }">
              {{ formatPct(reliability.availablePct) }}
            </span>
            <span class="reliability-label">Доступность</span>
            <span class="reliability-sublabel">АИ-92, АИ-95</span>
          </div>
          <div class="reliability-tile">
            <span class="reliability-value">{{ formatPct(reliability.noDataPct) }}</span>
            <span class="reliability-label">Нет данных</span>
          </div>
          <div class="reliability-tile">
            <span class="reliability-value">{{ reliability.outageCount }}</span>
            <span class="reliability-label">Отключений</span>
          </div>
          <div class="reliability-tile">
            <span class="reliability-value">{{ formatMinutes(reliability.avgOutageMinutes) }}</span>
            <span class="reliability-label">Ср. восстановление</span>
          </div>
        </div>

        <h4>Лента статусов за 7 дней</h4>
        <StationReliabilityTimeline :station-id="station.stationId" />

        <h4>Карточка для шаринга</h4>
        <p class="hint">
          Собирает статус, виды топлива и статистику надёжности в одну картинку — удобно
          скопировать и вставить в чат, не прикрепляя файл.
        </p>

        <template v-if="!cardUrl">
          <button type="button" class="btn secondary" :disabled="cardGenerating" @click="generateCard">
            {{ cardGenerating ? 'Генерация...' : '🖼 Сгенерировать картинку' }}
          </button>
        </template>
        <template v-else>
          <img :src="cardUrl" alt="Карточка станции" class="card-preview" />
          <div class="card-actions">
            <button type="button" class="btn secondary" @click="resetCard">Сгенерировать заново</button>
            <button
              v-if="clipboardSupported"
              type="button"
              class="btn secondary"
              @click="copyCardToClipboard"
            >
              {{ copyFeedback === 'ok' ? 'Скопировано ✓' : 'Скопировать в буфер' }}
            </button>
            <button v-if="canShareCard" type="button" class="btn secondary" @click="shareCard">
              Поделиться
            </button>
            <a :href="cardUrl" download="station-card.png" class="btn">Скачать</a>
          </div>
          <p v-if="!clipboardSupported" class="hint small">
            Этот браузер не поддерживает копирование картинки в буфер обмена — скачайте файл или
            воспользуйтесь «Поделиться».
          </p>
        </template>
        <p v-if="cardError" class="error-text">{{ cardError }}</p>

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
  /* .card's own shorthand padding still covers left/right/bottom; top is
     zeroed here so .modal-header (below) can own that inset itself and sit
     flush against the actual top of this scroll area - required for its
     sticky positioning to pin correctly instead of stopping short by the
     padding amount. */
  padding-top: 0;
}

.modal-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  /* Pinned to the top of .modal-card's own scroll area (not the viewport) -
     the name/address is the only thing telling you which station a long
     scroll of fuel-type/source/reliability tables belongs to. Owns the
     top/bottom padding .modal-card would otherwise supply (see its own
     padding-top:0 above) since a negative margin trick to reclaim that
     padding turned out not to interact well with sticky positioning
     (verified live: the header's static position didn't shift as
     expected, leaving its top portion clipped above the scroll area). The
     bottom border only becomes visually meaningful once content has
     scrolled under the header, since at rest it just sits flush above the
     status line below. */
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
  margin: 12px 0;
  /* Leaflet's own internal panes go up to z-index:700+ (popup/control
     layers) - without this, since the container itself never gets an
     explicit z-index, those values aren't contained to the map and are
     compared directly against sibling elements outside it (like the sticky
     .modal-header, z-index:1), painting the map on top of the header
     despite coming later in DOM order. Verified live: the map visibly
     overlapped the pinned name/address while scrolling. */
  isolation: isolate;
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

.fuel-list-active {
  background: #eff6ff;
  border-radius: 4px;
}

.badge-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.table-wrap {
  overflow-x: auto;
}

.fuel-table {
  margin-bottom: 8px;
}

.reliability-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
  margin: 8px 0 16px;
}

.reliability-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 10px 6px;
  background: #f8fafc;
  border-radius: 8px;
  text-align: center;
}

.reliability-value {
  font-size: 18px;
  font-weight: 700;
}

.reliability-label {
  font-size: 11px;
  color: #667;
}

.reliability-sublabel {
  font-size: 10px;
  color: #94a3b8;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}

.hint.small {
  font-size: 11px;
}

.fuel-cell-age {
  white-space: nowrap;
}

.header-meta {
  font-weight: normal;
  white-space: nowrap;
}

/* .card-preview/.card-actions moved to main.css - shared with the reports
   page's shareable report card. */
</style>
