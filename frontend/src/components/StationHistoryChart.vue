<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Chart from 'chart.js/auto';
import { stationsApi } from '../api/regions';
import { STATUS_ORDER, statusMeta, statusOrdinal, fuelTypeLabel, CORE_FUEL_TYPES } from '../utils/fuelStatus';
import { useFuelColorsStore } from '../store/fuelColors';

const props = defineProps({
  stationId: { type: String, required: true },
});

const canvasRef = ref(null);
const loading = ref(true);
const errorMessage = ref('');
let chart = null;
const fuelColors = useFuelColorsStore();

// CORE_FUEL_TYPES (imported above, shared with MapView.vue/stationCard.js) -
// with up to 5 fuel types (92/95/100/ДТ/propane/methane) all plotted as
// separate stepped lines on the same 4-value status axis, showing everything
// at once read as an illegible mess of overlapping lines. Non-core lines
// start hidden (Chart.js's own clickable legend, not removed from the chart
// entirely) rather than filtered out of the data - a driver curious about
// diesel/gas can still click that legend entry to bring it back for this
// one station.

function renderChart(snapshots) {
  const fuelTypes = [...new Set(snapshots.flatMap((s) => s.fuelStatuses.map((f) => f.fuelType)))];
  const labels = snapshots.map((s) => new Date(s.polledAt).toLocaleString('ru-RU'));
  const datasets = fuelTypes.map((fuelType) => ({
    label: fuelTypeLabel(fuelType),
    data: snapshots.map((s) => {
      const entry = s.fuelStatuses.find((f) => f.fuelType === fuelType);
      return entry ? statusOrdinal(entry.status) : null;
    }),
    borderColor: fuelColors.colorFor(fuelType),
    backgroundColor: fuelColors.colorFor(fuelType),
    spanGaps: true,
    stepped: true,
    hidden: !CORE_FUEL_TYPES.includes(fuelType),
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
    <p v-if="!loading && !errorMessage" class="hint small">
      По умолчанию показаны только АИ-92 и АИ-95 — остальные виды топлива скрыты, чтобы график не
      превращался в кашу из линий; нажмите на нужный вид топлива в легенде, чтобы его показать.
    </p>
  </div>
</template>

<style scoped>
.canvas-box {
  position: relative;
  height: 220px;
}

.hint.small {
  font-size: 11px;
  margin-top: 6px;
}
</style>
