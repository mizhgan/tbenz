<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import L from 'leaflet';
import { metricsApi } from '../api/metrics';
import { stationsApi } from '../api/regions';
import { statusMeta, fuelTypeLabel } from '../utils/fuelStatus';
import { availabilityColor, formatPct, formatMinutes } from '../utils/colorScale';
import { renderStationCard, canCopyImageToClipboard } from '../utils/stationCard';
import { canShareFile } from '../utils/mapExport';
import StationForecast from './StationForecast.vue';
import StationHistoryChart from './StationHistoryChart.vue';

const props = defineProps({
  station: { type: Object, required: true },
  regionId: { type: String, required: true },
  selectedFuelType: { type: String, default: '' },
});
const emit = defineEmits(['close']);

const miniMapContainer = ref(null);
let miniMap = null;

const reliabilityLoading = ref(true);
const reliabilityError = ref('');
const reliability = ref(null);

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
    const { stations } = await metricsApi.stations(props.regionId, {
      from: from.toISOString(),
      to: to.toISOString(),
    });
    reliability.value = stations.find((s) => String(s.stationId) === String(props.station.stationId)) || null;
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
    const [forecastResult, historyResult] = await Promise.allSettled([
      stationsApi.forecast(props.station.stationId, { hoursAhead: 12 }),
      stationsApi.history(props.station.stationId, { limit: 200 }),
    ]);
    const forecast = forecastResult.status === 'fulfilled' ? forecastResult.value : null;
    const history = historyResult.status === 'fulfilled' ? historyResult.value : null;

    const blob = await renderStationCard({
      station: props.station,
      reliability: reliability.value,
      forecast,
      history,
    });
    if (cardUrl.value) URL.revokeObjectURL(cardUrl.value);
    cardBlob = blob;
    cardUrl.value = URL.createObjectURL(blob);
    const safeName = (props.station.name || 'station').replace(/[^\p{L}\p{N}]+/gu, '-');
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
    await navigator.share({ files: [cardFile], title: `Статус станции: ${props.station.name || 'АЗС'}` });
  } catch (err) {
    if (err.name !== 'AbortError') {
      cardError.value = `Не удалось поделиться: ${err.message || 'неизвестная ошибка'}`;
    }
  }
}

onMounted(async () => {
  loadReliability();

  await nextTick();
  miniMap = L.map(miniMapContainer.value, {
    zoomControl: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    touchZoom: false,
    boxZoom: false,
    keyboard: false,
  }).setView([props.station.lat, props.station.lon], 15);
  miniMap.attributionControl.setPrefix(false);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
    crossOrigin: true,
  }).addTo(miniMap);
  L.circleMarker([props.station.lat, props.station.lon], {
    radius: 8,
    color: statusMeta(props.station.status).color,
    fillColor: statusMeta(props.station.status).color,
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
          <div>
            <h2>{{ station.name || 'АЗС' }}</h2>
            <p v-if="station.address" class="hint">{{ station.address }}</p>
          </div>
          <button type="button" class="link-btn close-btn" @click="emit('close')">✕</button>
        </div>

        <p>
          <span class="badge-dot" :style="{ background: statusMeta(station.status).color }"></span>
          {{ statusMeta(station.status).label }}
        </p>

        <div ref="miniMapContainer" class="mini-map"></div>

        <h4>Виды топлива</h4>
        <ul class="fuel-list">
          <li
            v-for="f in station.fuelStatuses"
            :key="f.fuelType"
            :class="{ 'fuel-list-active': f.fuelType === selectedFuelType }"
          >
            <strong>{{ fuelTypeLabel(f.fuelType) }}</strong>
            <span class="badge-dot" :style="{ background: statusMeta(f.status).color }"></span>
            {{ statusMeta(f.status).label }}
          </li>
        </ul>

        <p class="hint">
          Последняя транзакция:
          {{ station.lastTransactionAt ? formatDateTime(new Date(station.lastTransactionAt).getTime()) : 'нет данных' }}
        </p>
        <p class="hint">Снимок на момент: {{ formatDateTime(new Date(station.polledAt).getTime()) }}</p>

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

        <h4>Прогноз на ближайшие часы</h4>
        <StationForecast :station-id="station.stationId" />

        <h4>История по видам топлива</h4>
        <StationHistoryChart :station-id="station.stationId" />

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
  margin: 12px 0;
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
  margin: 0 -8px;
  padding-left: 8px;
  padding-right: 8px;
  border-radius: 4px;
}

.badge-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
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

.modal-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}

.hint.small {
  font-size: 11px;
}

/* .card-preview/.card-actions moved to main.css - shared with the reports
   page's shareable report card. */
</style>
