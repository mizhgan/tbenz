<script setup>
import { onMounted, ref, watch } from 'vue';
import { stationsApi } from '../api/regions';
import { availabilityColor, formatPct } from '../utils/colorScale';

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
</style>
