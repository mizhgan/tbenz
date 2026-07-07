<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Chart from 'chart.js/auto';
import { stationsApi } from '../api/regions';

const props = defineProps({
  stationId: { type: String, required: true },
});

const canvasRef = ref(null);
const loading = ref(true);
const errorMessage = ref('');
let chart = null;

const COLORS = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2'];

function renderChart(snapshots) {
  const fuelTypes = [...new Set(snapshots.flatMap((s) => s.fuels.map((f) => f.type)))];
  const labels = snapshots.map((s) => new Date(s.polledAt).toLocaleString('ru-RU'));
  const datasets = fuelTypes.map((type, idx) => ({
    label: type,
    data: snapshots.map((s) => s.fuels.find((f) => f.type === type)?.price ?? null),
    borderColor: COLORS[idx % COLORS.length],
    backgroundColor: COLORS[idx % COLORS.length],
    spanGaps: true,
    tension: 0.2,
  }));

  if (chart) chart.destroy();
  chart = new Chart(canvasRef.value, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: { y: { beginAtZero: false } },
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
