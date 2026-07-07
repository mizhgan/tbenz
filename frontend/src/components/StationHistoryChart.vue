<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Chart from 'chart.js/auto';
import { stationsApi } from '../api/regions';
import { STATUS_ORDER, statusMeta, statusOrdinal } from '../utils/fuelStatus';

const props = defineProps({
  stationId: { type: String, required: true },
});

const canvasRef = ref(null);
const loading = ref(true);
const errorMessage = ref('');
let chart = null;

const SERIES_COLORS = ['#2563eb', '#7c3aed', '#0891b2', '#be185d', '#059669', '#ca8a04'];

function renderChart(snapshots) {
  const fuelTypes = [...new Set(snapshots.flatMap((s) => s.fuelStatuses.map((f) => f.fuelType)))];
  const labels = snapshots.map((s) => new Date(s.polledAt).toLocaleString('ru-RU'));
  const datasets = fuelTypes.map((fuelType, idx) => ({
    label: `АИ-${fuelType}`,
    data: snapshots.map((s) => {
      const entry = s.fuelStatuses.find((f) => f.fuelType === fuelType);
      return entry ? statusOrdinal(entry.status) : null;
    }),
    borderColor: SERIES_COLORS[idx % SERIES_COLORS.length],
    backgroundColor: SERIES_COLORS[idx % SERIES_COLORS.length],
    spanGaps: true,
    stepped: true,
  }));

  if (chart) chart.destroy();
  chart = new Chart(canvasRef.value, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${statusMeta(STATUS_ORDER[ctx.parsed.y]).label}`,
          },
        },
      },
      scales: {
        y: {
          min: 0,
          max: STATUS_ORDER.length - 1,
          ticks: {
            stepSize: 1,
            callback: (value) => statusMeta(STATUS_ORDER[value])?.label ?? '',
          },
        },
      },
    },
  });
}

async function loadAndRender() {
  loading.value = true;
  errorMessage.value = '';
  try {
    const snapshots = await stationsApi.history(props.stationId, { limit: 500 });
    if (!snapshots.length) {
      errorMessage.value = 'Пока нет истории по этой станции';
      return;
    }
    renderChart(snapshots);
  } catch (err) {
    errorMessage.value = 'Не удалось загрузить историю';
  } finally {
    loading.value = false;
  }
}

onMounted(loadAndRender);
watch(() => props.stationId, loadAndRender);
onBeforeUnmount(() => {
  if (chart) chart.destroy();
});
</script>

<template>
  <div>
    <p v-if="loading">Загрузка истории...</p>
    <p v-else-if="errorMessage" class="error-text">{{ errorMessage }}</p>
    <div v-show="!loading && !errorMessage" class="canvas-box">
      <canvas ref="canvasRef"></canvas>
    </div>
  </div>
</template>

<style scoped>
.canvas-box {
  position: relative;
  height: 220px;
}
</style>
