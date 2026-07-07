<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Chart from 'chart.js/auto';

const props = defineProps({
  buckets: { type: Array, default: () => [] },
});

const canvasRef = ref(null);
let chart = null;

function renderChart() {
  const labels = props.buckets.map((b) => new Date(b.bucketStart).toLocaleString('ru-RU'));
  const datasets = [
    {
      label: 'Доступно',
      data: props.buckets.map((b) => b.availablePct),
      borderColor: '#16a34a',
      backgroundColor: 'rgba(22, 163, 74, 0.35)',
      fill: true,
      stack: 'status',
      tension: 0.2,
      spanGaps: true,
    },
    {
      label: 'Возможно доступно',
      data: props.buckets.map((b) => b.maybeAvailablePct),
      borderColor: '#d97706',
      backgroundColor: 'rgba(217, 119, 6, 0.3)',
      fill: true,
      stack: 'status',
      tension: 0.2,
      spanGaps: true,
    },
    {
      label: 'Недоступно',
      data: props.buckets.map((b) => b.notAvailablePct),
      borderColor: '#dc2626',
      backgroundColor: 'rgba(220, 38, 38, 0.3)',
      fill: true,
      stack: 'status',
      tension: 0.2,
      spanGaps: true,
    },
  ];

  if (chart) chart.destroy();
  chart = new Chart(canvasRef.value, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        y: { stacked: true, min: 0, max: 100, ticks: { callback: (v) => `${v}%` } },
      },
    },
  });
}

onMounted(renderChart);
watch(() => props.buckets, renderChart, { deep: true });
onBeforeUnmount(() => {
  if (chart) chart.destroy();
});
</script>

<template>
  <div class="chart-box">
    <p v-if="!buckets.length" class="hint">Нет данных за выбранный период.</p>
    <canvas v-show="buckets.length" ref="canvasRef"></canvas>
  </div>
</template>

<style scoped>
.chart-box {
  position: relative;
  height: 280px;
}
</style>
