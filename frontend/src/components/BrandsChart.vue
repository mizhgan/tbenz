<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Chart from 'chart.js/auto';
import { availabilityColor } from '../utils/colorScale';

const props = defineProps({
  brands: { type: Array, default: () => [] },
});

const canvasRef = ref(null);
let chart = null;

// Uncapped on purpose - each row needs enough height for its label to stay
// readable, otherwise Chart.js's tick autoSkip starts hiding every other
// network name. The outer .chart-box scrolls instead of capping this.
const boxHeight = computed(() => `${Math.max(120, props.brands.length * 28)}px`);

async function renderChart() {
  // Never construct Chart.js while the canvas is hidden: Chart.js snapshots
  // the canvas's *own* inline style on construction and restores it
  // verbatim on destroy(). If our wrapper's v-show had ever set
  // display:none directly on the canvas at construction time, every future
  // destroy()+recreate cycle would keep restoring "none" (Chart.js's own
  // fallback is `style.display || 'block'`, and the non-empty string
  // 'none' is truthy, so the fallback never kicks in) - the chart would
  // get stuck invisible forever, even once there's data again. v-show
  // lives on a wrapper div (not the canvas) specifically to avoid this,
  // but skipping construction entirely while there's nothing to show is a
  // cheap extra safeguard.
  if (!props.brands.length) {
    if (chart) {
      chart.destroy();
      chart = null;
    }
    return;
  }

  // The container's height depends on brands.length (set below via boxHeight)
  // and changes in the same tick as this re-render; wait for Vue to actually
  // apply that new height to the DOM before Chart.js measures the canvas,
  // otherwise it can size itself against the stale (pre-update) dimensions.
  await nextTick();

  const sorted = [...props.brands].sort((a, b) => (b.avgAvailablePct ?? -1) - (a.avgAvailablePct ?? -1));
  const labels = sorted.map((b) => `${b.name} (${b.stationCount})`);
  const data = sorted.map((b) => b.avgAvailablePct);

  if (chart) chart.destroy();
  if (!canvasRef.value) return;
  chart = new Chart(canvasRef.value, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Средняя доступность, %',
          data,
          backgroundColor: data.map((v) => availabilityColor(v)),
        },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { min: 0, max: 100, ticks: { callback: (v) => `${v}%` } },
        // Autoskip would otherwise hide every other network name once
        // there are more than a handful of rows - we'd rather scroll the
        // container (see .chart-box) than lose labels.
        y: { ticks: { autoSkip: false } },
      },
    },
  });
}

onMounted(renderChart);
watch(() => props.brands, renderChart, { deep: true });
onBeforeUnmount(() => {
  if (chart) chart.destroy();
});
</script>

<template>
  <div class="chart-box">
    <p v-if="!brands.length" class="hint">Нет данных за выбранный период.</p>
    <div v-show="brands.length" class="canvas-wrap" :style="{ height: boxHeight }">
      <canvas ref="canvasRef"></canvas>
    </div>
  </div>
</template>

<style scoped>
.chart-box {
  position: relative;
  max-height: 480px;
  overflow-y: auto;
}

.canvas-wrap {
  position: relative;
}
</style>
