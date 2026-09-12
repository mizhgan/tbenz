<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Chart from 'chart.js/auto';
import { formatMinutes, bucketPeriodLabel } from '../utils/colorScale';

// Merges what used to be two separate components (TrendChart.vue,
// RecoveryTrendChart.vue) into one card with two linked Chart.js instances -
// requested live after aligning their x-axes (see metricsService.js's
// enumerateBucketStarts/getSnapshotDataBounds) made it obvious the two
// charts describe the same timeline and should read as one unit, not a
// literal single chart: availability (%) and recovery time (unbounded
// minutes/hours) are different units, so one shared Y axis (or a second one)
// would misrepresent one of them - see this component's own git history for
// the fuller reasoning. What actually delivers "feels like one chart" is
// synced hover: moving the mouse over either canvas drives the *same*
// category index's tooltip on both, via Chart.js's own
// setActiveElements/tooltip.setActiveElements API (no crosshair plugin
// needed - both canvases already share the exact same labels array/order
// thanks to the x-axis alignment fix, so "index i" means the same date in
// both without any date-matching).
const props = defineProps({
  trendBuckets: { type: Array, default: () => [] },
  forecastBuckets: { type: Array, default: () => [] },
  recoveryBuckets: { type: Array, default: () => [] },
  bucketHours: { type: Number, default: 24 },
  direction: { type: String, default: 'unknown' },
  trendErrorMessage: { type: String, default: '' },
  recoveryErrorMessage: { type: String, default: '' },
});

const DIRECTION_META = {
  improving: { label: 'Улучшается', icon: '📈', color: '#16a34a' },
  worsening: { label: 'Ухудшается', icon: '📉', color: '#dc2626' },
  stable: { label: 'Стабильно', icon: '➖', color: '#6b7280' },
  unknown: { label: 'Недостаточно данных', icon: '❔', color: '#6b7280' },
};

const hasRecoveryData = computed(() => props.recoveryBuckets.some((b) => b.outageCount > 0));

const trendCanvasRef = ref(null);
const recoveryCanvasRef = ref(null);
let trendChart = null;
let recoveryChart = null;

// Drives `chart`'s own hover/tooltip to the given category index (or clears
// it for index === null) - reused as the target side of both onHover
// callbacks below. Datasets with no value at this index (the padded
// forecast slots on either chart, or the historical-only series once
// hovering into the forecast region) are left out of the active set rather
// than showing an empty tooltip row for them.
function setSyncedIndex(chart, index) {
  if (!chart) return;
  const active =
    index === null
      ? []
      : chart.data.datasets
          .map((_, datasetIndex) => ({ datasetIndex, index }))
          .filter((a) => {
            const v = chart.data.datasets[a.datasetIndex].data[index];
            return v !== null && v !== undefined;
          });
  chart.setActiveElements(active);
  chart.tooltip?.setActiveElements(active, { x: 0, y: 0 });
  chart.update();
}

function renderTrendChart() {
  // Never construct Chart.js on a hidden canvas: Chart.js snapshots the
  // canvas's *own* inline style on construction and restores it verbatim on
  // destroy(). If v-show had set display:none directly on the canvas at
  // that moment, every future destroy()+recreate cycle keeps restoring
  // "none" (Chart.js's own display fallback is `style.display || 'block'`,
  // and the non-empty string 'none' is truthy, so the fallback never
  // kicks in) - the chart gets permanently stuck invisible even after the
  // data (and v-show) say it should be visible again. Skipping
  // construction entirely while there's nothing to show avoids ever
  // creating that poisoned snapshot.
  if (props.trendBuckets.length <= 1) {
    if (trendChart) {
      trendChart.destroy();
      trendChart = null;
    }
    return;
  }

  const histLen = props.trendBuckets.length;
  const forecastLen = props.forecastBuckets.length;

  const labels = [
    ...props.trendBuckets.map((b) => new Date(b.bucketStart).toLocaleString('ru-RU')),
    ...props.forecastBuckets.map((b) => `${new Date(b.bucketStart).toLocaleString('ru-RU')} (прогноз)`),
  ];

  const pad = (values) => [...values, ...new Array(forecastLen).fill(null)];

  const datasets = [
    {
      label: 'Доступно',
      data: pad(props.trendBuckets.map((b) => b.availablePct)),
      borderColor: '#16a34a',
      backgroundColor: 'rgba(22, 163, 74, 0.35)',
      fill: true,
      stack: 'status',
      tension: 0.2,
      spanGaps: true,
    },
    {
      label: 'Возможно доступно',
      data: pad(props.trendBuckets.map((b) => b.maybeAvailablePct)),
      borderColor: '#d97706',
      backgroundColor: 'rgba(217, 119, 6, 0.3)',
      fill: true,
      stack: 'status',
      tension: 0.2,
      spanGaps: true,
    },
    {
      label: 'Недоступно',
      data: pad(props.trendBuckets.map((b) => b.notAvailablePct)),
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
    if (histLen > 0) forecastLine[histLen - 1] = props.trendBuckets[histLen - 1].availablePct;
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

  if (trendChart) trendChart.destroy();
  trendChart = new Chart(trendCanvasRef.value, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      onHover: (_event, activeElements) => {
        setSyncedIndex(recoveryChart, activeElements.length ? activeElements[0].index : null);
      },
      scales: {
        y: { stacked: true, min: 0, max: 100, ticks: { callback: (v) => `${v}%` } },
      },
    },
  });
}

function renderRecoveryChart() {
  // Same reasoning as renderTrendChart's own guard above - the canvas must
  // stay permanently in the DOM either way (v-show in the template below,
  // not v-if/v-else) so canvasRef is never null right when the data flips
  // from empty to non-empty and the watcher fires.
  if (!hasRecoveryData.value) {
    if (recoveryChart) {
      recoveryChart.destroy();
      recoveryChart = null;
    }
    return;
  }

  // Padded with as many trailing (unlabeled-as-such, undrawn) slots as the
  // trend chart has forecast points, so both charts' category axes stay the
  // same length - see metricsService.js's getSnapshotDataBounds doc comment
  // for the fuller alignment story this is one half of.
  const histLen = props.recoveryBuckets.length;
  const labels = [
    ...props.recoveryBuckets.map((b) => new Date(b.bucketStart).toLocaleString('ru-RU')),
    ...props.forecastBuckets.map((b) => `${new Date(b.bucketStart).toLocaleString('ru-RU')} (прогноз)`),
  ];
  const data = [
    ...props.recoveryBuckets.map((b) => b.avgRecoveryMinutes),
    ...new Array(props.forecastBuckets.length).fill(null),
  ];

  if (recoveryChart) recoveryChart.destroy();
  recoveryChart = new Chart(recoveryCanvasRef.value, {
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
      interaction: { mode: 'index', intersect: false },
      onHover: (_event, activeElements) => {
        setSyncedIndex(trendChart, activeElements.length ? activeElements[0].index : null);
      },
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
              const bucket = ctx.dataIndex < histLen ? props.recoveryBuckets[ctx.dataIndex] : null;
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

// Clears both charts' synced hover state together - covers either canvas's
// own mouseleave, since Chart.js's onHover firing with an empty
// activeElements array (the mouse leaving *that* canvas) already clears the
// other one via setSyncedIndex, but not necessarily itself.
function clearBothHover() {
  setSyncedIndex(trendChart, null);
  setSyncedIndex(recoveryChart, null);
}

onMounted(() => {
  renderTrendChart();
  renderRecoveryChart();
});
watch(() => [props.trendBuckets, props.forecastBuckets], renderTrendChart, { deep: true });
watch(() => [props.recoveryBuckets, props.bucketHours, props.forecastBuckets], renderRecoveryChart, { deep: true });
onBeforeUnmount(() => {
  if (trendChart) trendChart.destroy();
  if (recoveryChart) recoveryChart.destroy();
});
</script>

<template>
  <div class="card section combo-chart">
    <div class="section-header">
      <h2>Динамика доступности <span class="hint small">(АИ-92, АИ-95)</span></h2>
      <span class="direction-badge" :style="{ color: DIRECTION_META[direction].color }">
        {{ DIRECTION_META[direction].icon }} {{ DIRECTION_META[direction].label }}
      </span>
    </div>
    <p v-if="trendErrorMessage" class="error-text">{{ trendErrorMessage }}</p>
    <div class="chart-box" @mouseleave="clearBothHover">
      <p v-if="!trendBuckets.length" class="hint">Нет данных за выбранный период.</p>
      <p v-else-if="trendBuckets.length === 1" class="hint">
        За этот период есть только один опрос — слишком мало для графика. Выберите период подольше.
      </p>
      <div v-show="trendBuckets.length > 1" class="canvas-wrap">
        <canvas ref="trendCanvasRef"></canvas>
      </div>
    </div>
    <p class="hint small">
      Пунктир — простая линейная экстраполяция последних данных, а не точный прогноз: это грубая
      оценка направления тренда, без учёта сезонности.
    </p>

    <div class="combo-divider"></div>

    <h3>Время восстановления после отключений <span class="hint small">(АИ-92, АИ-95)</span></h3>
    <p v-if="recoveryErrorMessage" class="error-text">{{ recoveryErrorMessage }}</p>
    <div class="chart-box chart-box--short" @mouseleave="clearBothHover">
      <p v-if="!hasRecoveryData" class="hint">
        За этот период не было отключений с восстановлением — графику не по чему строиться.
      </p>
      <div v-show="hasRecoveryData" class="canvas-wrap">
        <canvas ref="recoveryCanvasRef"></canvas>
      </div>
    </div>
    <p class="hint small">
      Среднее время от «пропало» до «появилось» по всем станциям района {{ bucketPeriodLabel(bucketHours) }} —
      растущий график значит, что топливо не только реже есть, но и дольше не появляется.
    </p>
  </div>
</template>

<style scoped>
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.section-header h2 {
  margin: 0;
}

.direction-badge {
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
}

.combo-chart h3 {
  font-size: 15px;
  margin: 0 0 4px;
}

.combo-divider {
  border-top: 1px solid #e5e7eb;
  margin: 20px 0 16px;
}

[data-theme='dark'] .combo-divider {
  border-top-color: #334155;
}

.chart-box {
  position: relative;
  height: 280px;
}

.chart-box--short {
  height: 240px;
}

.canvas-wrap {
  position: relative;
  height: 100%;
}
</style>
