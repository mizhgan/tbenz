<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Chart from 'chart.js/auto';

const props = defineProps({
  buckets: { type: Array, default: () => [] },
  forecastBuckets: { type: Array, default: () => [] },
});

const canvasRef = ref(null);
let chart = null;

function renderChart() {
  const histLen = props.buckets.length;
  const forecastLen = props.forecastBuckets.length;

  const labels = [
    ...props.buckets.map((b) => new Date(b.bucketStart).toLocaleString('ru-RU')),
    ...props.forecastBuckets.map((b) => `${new Date(b.bucketStart).toLocaleString('ru-RU')} (прогноз)`),
  ];

  const pad = (values) => [...values, ...new Array(forecastLen).fill(null)];

  const datasets = [
    {
      label: 'Доступно',
      data: pad(props.buckets.map((b) => b.availablePct)),
      borderColor: '#16a34a',
      backgroundColor: 'rgba(22, 163, 74, 0.35)',
      fill: true,
      stack: 'status',
      tension: 0.2,
      spanGaps: true,
    },
    {
      label: 'Возможно доступно',
      data: pad(props.buckets.map((b) => b.maybeAvailablePct)),
      borderColor: '#d97706',
      backgroundColor: 'rgba(217, 119, 6, 0.3)',
      fill: true,
      stack: 'status',
      tension: 0.2,
      spanGaps: true,
    },
    {
      label: 'Недоступно',
      data: pad(props.buckets.map((b) => b.notAvailablePct)),
      borderColor: '#dc2626',
      backgroundColor: 'rgba(220, 38, 38, 0.3)',
      fill: true,
      stack: 'status',
      tension: 0.2,
      spanGaps: true,
    },
  ];

  if (forecastLen > 0) {
    const forecastLine = new Array(histLen).fill(null);
    if (histLen > 0) forecastLine[histLen - 1] = props.buckets[histLen - 1].availablePct;
    forecastLine.push(...props.forecastBuckets.map((b) => b.availablePct));
    datasets.push({
      label: 'Прогноз доступности',
      data: forecastLine,
      borderColor: '#2563eb',
      backgroundColor: 'transparent',
      borderDash: [6, 4],
      fill: false,
      stack: 'forecast-line',
      tension: 0.2,
      spanGaps: true,
      pointRadius: (ctx) => (ctx.dataIndex >= histLen ? 3 : 0),
    });
  }

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
watch(() => [props.buckets, props.forecastBuckets], renderChart, { deep: true });
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
