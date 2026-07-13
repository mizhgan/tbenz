<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Chart from 'chart.js/auto';
import { formatMinutes } from '../utils/colorScale';

const props = defineProps({
  buckets: { type: Array, default: () => [] },
});

const canvasRef = ref(null);
let chart = null;

// Guards against constructing Chart.js while there's nothing to plot - the
// canvas itself must stay permanently in the DOM either way (v-show in the
// template below, not v-if/v-else): an empty-to-non-empty transition
// otherwise flips canvasRef from null to a real element on the very tick
// the watcher below fires, before Vue has actually patched the DOM, which
// is exactly what "can't acquire context from the given item" turned out
// to mean here (confirmed live). Same v-show reasoning as TrendChart.vue's
// own guard, just a different failure mode of the same underlying "canvas
// element isn't reliably there yet" class of bug.
function renderChart() {
  if (!props.buckets.length) {
    if (chart) {
      chart.destroy();
      chart = null;
    }
    return;
  }

  const labels = props.buckets.map((b) => new Date(b.bucketStart).toLocaleDateString('ru-RU'));

  if (chart) chart.destroy();
  chart = new Chart(canvasRef.value, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Среднее время восстановления',
          data: props.buckets.map((b) => b.avgRecoveryMinutes),
          backgroundColor: 'rgba(37, 99, 235, 0.55)',
          borderColor: '#2563eb',
          borderWidth: 1,
          borderRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const bucket = props.buckets[ctx.dataIndex];
              return [`${formatMinutes(bucket.avgRecoveryMinutes)} в среднем`, `${bucket.outageCount} отключений за день`];
            },
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { callback: (v) => formatMinutes(v) },
        },
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
    <p v-if="!buckets.length" class="hint">
      За этот период не было отключений с восстановлением — графику не по чему строиться.
    </p>
    <!-- v-show, not v-if/v-else - the canvas must always exist in the DOM
         (see renderChart's own doc comment on TrendChart.vue's identical
         guard) so canvasRef is never null right when buckets flips from
         empty to non-empty and the watcher fires. -->
    <div v-show="buckets.length > 0" class="canvas-wrap">
      <canvas ref="canvasRef"></canvas>
    </div>
  </div>
</template>

<style scoped>
.chart-box {
  position: relative;
  height: 240px;
}

.canvas-wrap {
  position: relative;
  height: 100%;
}
</style>
