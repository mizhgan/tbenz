<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { stationsApi } from '../api/regions';
import { availabilityColor, formatMinutes, formatPct } from '../utils/colorScale';

const props = defineProps({
  stationId: { type: String, required: true },
});

const loading = ref(true);
const errorMessage = ref('');
const forecast = ref(null);

function formatHour(iso) {
  return new Date(iso).toLocaleString('ru-RU', {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// basis values: 'trend' (anchored to the actual current status, shaped by a
// short recent trend - near-term hours), 'current' (anchored to the actual
// current status with no trend data yet, held flat), 'hour-profile' (this
// station's own typical availability for this hour of day - further-out
// hours), 'trend+hour-profile'/'current+hour-profile' (blend during the
// handoff window), 'flat-average' (an hour-profile cell too thin to trust,
// falls back to the plain average), 'no-data'. See forecastService.js's
// getStationForecastUncached/blendHourForecast doc comments for why these
// signals exist and how they're combined.
function basisNote(basis) {
  if (basis === 'no-data') return ' (нет истории)';
  if (basis === 'flat-average') return ' (мало данных, среднее)';
  if (basis === 'hour-profile') return ' (обычно в это время суток)';
  if (basis === 'trend+hour-profile' || basis === 'current+hour-profile') return ' (тренд + обычно в это время)';
  return '';
}

function formatOutageDate(iso) {
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Longest of the *shown* outages, not all-time - a bar chart's whole point
// is relative comparison within what's actually on screen right now.
const maxOutageMinutes = computed(() =>
  Math.max(1, ...(forecast.value?.recentOutages || []).map((o) => o.durationMinutes))
);
function outageBarWidth(minutes) {
  return `${Math.max(4, (minutes / maxOutageMinutes.value) * 100)}%`;
}

async function load() {
  loading.value = true;
  errorMessage.value = '';
  try {
    forecast.value = await stationsApi.forecast(props.stationId, { hoursAhead: 12 });
  } catch (err) {
    errorMessage.value = 'Не удалось загрузить прогноз';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(() => props.stationId, load);
</script>

<template>
  <div>
    <p v-if="loading">Загрузка прогноза...</p>
    <p v-else-if="errorMessage" class="error-text">{{ errorMessage }}</p>
    <div v-else-if="forecast">
      <p
        v-if="forecast.currentStatus === 'not_available' && forecast.estimatedRecoveryAt"
        class="hint"
      >
        Ожидаемое восстановление: ~{{ formatHour(forecast.estimatedRecoveryAt) }} (по истории
        станции)
      </p>
      <p v-else-if="forecast.currentStatus === 'not_available'" class="hint">
        Недоступно; недостаточно истории, чтобы оценить время восстановления.
      </p>

      <div class="forecast-bars">
        <div
          v-for="h in forecast.hours"
          :key="h.at"
          class="forecast-bar"
          :title="`${formatHour(h.at)}: ${formatPct(h.availablePct)}${basisNote(h.basis)}`"
        >
          <div
            class="bar-fill"
            :style="{ height: `${h.availablePct ?? 0}%`, background: availabilityColor(h.availablePct) }"
          ></div>
          <div class="bar-label">{{ new Date(h.at).getHours() }}</div>
        </div>
      </div>
      <p class="hint small">
        Ближайшие часы — по недавней динамике станции (АИ-92, АИ-95), дальше — по тому, как
        обычно выглядит доступность в это время суток на этой станции. Грубая оценка, не точный
        прогноз.
      </p>

      <template v-if="forecast.recentOutages?.length">
        <h5 class="outages-title">
          Последние отключения <span class="hint small">(АИ-92, АИ-95)</span>
        </h5>
        <div class="outage-row" v-for="o in forecast.recentOutages" :key="o.start">
          <span class="outage-date">{{ formatOutageDate(o.start) }}</span>
          <div class="outage-bar-track">
            <div class="outage-bar-fill" :style="{ width: outageBarWidth(o.durationMinutes) }"></div>
          </div>
          <span class="outage-duration">{{ formatMinutes(o.durationMinutes) }}</span>
        </div>
        <p v-if="forecast.outageCount > forecast.recentOutages.length" class="hint small">
          Показаны последние {{ forecast.recentOutages.length }} из {{ forecast.outageCount }} за 28 дней.
        </p>
      </template>
      <p v-else class="hint small">За последние 28 дней отключений с восстановлением не было.</p>
    </div>
  </div>
</template>

<style scoped>
.forecast-bars {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 60px;
  margin: 8px 0;
}

.forecast-bar {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  height: 100%;
}

.bar-fill {
  width: 100%;
  border-radius: 2px 2px 0 0;
  min-height: 2px;
}

.bar-label {
  font-size: 9px;
  color: #667;
  margin-top: 2px;
}

.hint.small {
  font-size: 11px;
}

.outages-title {
  font-size: 13px;
  margin: 12px 0 6px;
}

.outage-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  font-size: 12px;
}

.outage-date {
  flex: 0 0 96px;
  color: #667;
}

.outage-bar-track {
  flex: 1;
  height: 8px;
  background: #f1f5f9;
  border-radius: 4px;
  overflow: hidden;
}

.outage-bar-fill {
  height: 100%;
  background: #dc2626;
  border-radius: 4px;
}

.outage-duration {
  flex: 0 0 56px;
  text-align: right;
  font-weight: 600;
}
</style>
