<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Chart from 'chart.js/auto';
import { availabilityColor } from '../utils/colorScale';

const props = defineProps({
  brands: { type: Array, default: () => [] },
});

const canvasRef = ref(null);
let chart = null;

const boxHeight = computed(() => `${Math.min(400, Math.max(120, props.brands.length * 32))}px`);

async function renderChart() {
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
  <div class="chart-box" :style="{ height: boxHeight }">
    <p v-if="!brands.length" class="hint">Нет данных за выбранный период.</p>
    <canvas v-show="brands.length" ref="canvasRef"></canvas>
  </div>
</template>

<style scoped>
.chart-box {
  position: relative;
}
</style>
