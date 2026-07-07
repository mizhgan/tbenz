<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Chart from 'chart.js/auto';
import { availabilityColor } from '../utils/colorScale';

const props = defineProps({
  brands: { type: Array, default: () => [] },
});

const canvasRef = ref(null);
let chart = null;

function renderChart() {
  const sorted = [...props.brands].sort((a, b) => (b.avgAvailablePct ?? -1) - (a.avgAvailablePct ?? -1));
  const labels = sorted.map((b) => `${b.name} (${b.stationCount})`);
  const data = sorted.map((b) => b.avgAvailablePct);

  if (chart) chart.destroy();
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
  <div class="chart-box" :style="{ height: `${Math.max(120, brands.length * 32)}px` }">
    <p v-if="!brands.length" class="hint">Нет данных за выбранный период.</p>
    <canvas v-show="brands.length" ref="canvasRef"></canvas>
  </div>
</template>

<style scoped>
.chart-box {
  position: relative;
}
</style>
