<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Chart from 'chart.js/auto';
import { formatMinutes, bucketPeriodLabel } from '../utils/colorScale';

const props = defineProps({
  buckets: { type: Array, default: () => [] },
  bucketHours: { type: Number, default: 24 },
  // Only used to reserve the same number of trailing x-axis slots
  // TrendChart.vue's own forecast dashed line occupies - see renderChart's
  // own doc comment on why. This chart never plots a value in them.
  forecastBuckets: { type: Array, default: () => [] },
});

// getRecoveryTrend now gap-fills every expected bucket (see
// metricsService.js's enumerateBucketStarts), so `buckets` is never empty
// as long as the period spans at least one bucket - it's an all-null array
// instead of []. "No data" now means "no bucket actually had a recovered
// outage", not "the array is empty".
const hasData = computed(() => props.buckets.some((b) => b.outageCount > 0));

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
  if (!hasData.value) {
    if (chart) {
      chart.destroy();
      chart = null;
    }
    return;
  }

  // Full date+time (not just the date) - the backend now buckets by hour
  // for a short-enough range (see metricsService.getRecoveryTrend's own
  // bucketHours), and a bare date would show several identical-looking
  // hourly bars with no way to tell them apart.
  //
  // Padded with as many trailing (unlabeled-as-such, undrawn) slots as
  // TrendChart.vue has forecast points - Chart.js stretches however many
  // category slots a chart has across its own container's full width, so
  // without this, a bare-bones bar count here vs. buckets+forecast right
  // above it desyncs the two charts' x-axis spacing even though both cover
  // the exact same period (reported live, both on the reports page itself
  // and the generated share card). Matching slot counts keeps the same
  // date at the same x position in both.
  const histLen = props.buckets.length;
  const labels = [
    ...props.buckets.map((b) => new Date(b.bucketStart).toLocaleString('ru-RU')),
    ...props.forecastBuckets.map((b) => `${new Date(b.bucketStart).toLocaleString('ru-RU')} (прогноз)`),
  ];
  const data = [...props.buckets.map((b) => b.avgRecoveryMinutes), ...new Array(props.forecastBuckets.length).fill(null)];

  if (chart) chart.destroy();
  chart = new Chart(canvasRef.value, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Среднее время восстановления',
          data,
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
              // ctx.dataIndex can land in the padded forecast region above
              // (no real bucket there, just reserved space) - those never
              // have a non-null value, so Chart.js shouldn't invoke this at
              // all for them, but this guards it explicitly rather than
              // relying on that.
              const bucket = ctx.dataIndex < histLen ? props.buckets[ctx.dataIndex] : null;
              if (!bucket) return [];
              return [
                `${formatMinutes(bucket.avgRecoveryMinutes)} в среднем`,
                `${bucket.outageCount} отключений ${bucketPeriodLabel(props.bucketHours)}`,
              ];
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
watch(() => [props.buckets, props.bucketHours, props.forecastBuckets], renderChart, { deep: true });
onBeforeUnmount(() => {
  if (chart) chart.destroy();
});
</script>

<template>
  <div class="chart-box">
    <p v-if="!hasData" class="hint">
      За этот период не было отключений с восстановлением — графику не по чему строиться.
    </p>
    <!-- v-show, not v-if/v-else - the canvas must always exist in the DOM
         (see renderChart's own doc comment on TrendChart.vue's identical
         guard) so canvasRef is never null right when buckets flips from
         empty to non-empty and the watcher fires. -->
    <div v-show="hasData" class="canvas-wrap">
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
