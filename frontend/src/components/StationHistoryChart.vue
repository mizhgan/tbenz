<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Chart from 'chart.js/auto';
// Registers Chart.js's 'time' scale adapter (date-fns under the hood) -
// needed so the x-axis below can be a real time scale instead of a
// category scale. See this component's own git history for why: a
// category axis treated every one of up to 500 raw poll timestamps as its
// own evenly-spaced label, so irregular polling gaps rendered as equal
// width and the tick text (a full "14.07.2026, 09:15:23" per point) turned
// into unreadable overlapping mush. A time scale spaces points by real
// elapsed time and picks its own clean, evenly-spaced ticks.
import 'chartjs-adapter-date-fns';
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
  // {x, y} points (real timestamps), not a shared labels array - lets the
  // time scale below place each point at its actual polledAt instead of
  // spacing every point evenly regardless of real polling gaps.
  const datasets = fuelTypes.map((fuelType) => ({
    label: fuelTypeLabel(fuelType),
    data: snapshots.map((s) => {
      const entry = s.fuelStatuses.find((f) => f.fuelType === fuelType);
      return { x: new Date(s.polledAt).getTime(), y: entry ? statusOrdinal(entry.status) : null };
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
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        tooltip: {
          callbacks: {
            title: (items) => (items.length ? new Date(items[0].parsed.x).toLocaleString('ru-RU') : ''),
            label: (ctx) => `${ctx.dataset.label}: ${statusMeta(STATUS_ORDER[ctx.parsed.y]).label}`,
          },
        },
      },
      scales: {
        x: {
          type: 'time',
          time: { tooltipFormat: 'dd.MM.yyyy HH:mm', displayFormats: { hour: 'dd.MM HH:mm', day: 'dd.MM', week: 'dd.MM', month: 'MM.yyyy' } },
          ticks: { autoSkip: true, maxRotation: 0 },
        },
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
