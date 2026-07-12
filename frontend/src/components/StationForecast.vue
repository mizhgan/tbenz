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
          :title="`${formatHour(h.at)}: ${formatPct(h.availablePct)}${h.basis === 'no-data' ? ' (нет истории)' : ''}`"
        >
          <div
            class="bar-fill"
            :style="{ height: `${h.availablePct ?? 0}%`, background: availabilityColor(h.availablePct) }"
          ></div>
          <div class="bar-label">{{ new Date(h.at).getHours() }}</div>
        </div>
      </div>
      <p class="hint small">
        Оценка по истории доступности АИ-92 и АИ-95 на станции в этот день недели и час — не
        точный прогноз.
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
