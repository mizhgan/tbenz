<script setup>
import { computed } from 'vue';
import { availabilityColor, formatPct } from '../utils/colorScale';

const props = defineProps({
  cells: { type: Array, default: () => [] },
});

const WEEKDAY_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

const cellByKey = computed(() => {
  const map = new Map();
  for (const cell of props.cells) {
    map.set(`${cell.weekday}-${cell.hour}`, cell);
  }
  return map;
});

function cellFor(weekday, hour) {
  return cellByKey.value.get(`${weekday}-${hour}`) || null;
}

function percentile(sortedValues, p) {
  const idx = (sortedValues.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo];
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (idx - lo);
}

// availabilityColor's hue is a straight 0-100% mapping - fine for a single
// number, but this grid plots up to 168 of them at once, and a region whose
// real availability sits in one narrow band all period (as this one
// usually does - see the KPI card right above) then paints every cell some
// shade of the same yellow-green regardless of real hour-to-hour/weekday-to-
// weekday differences: a 38%-vs-45% cell pair is only ~8° of hue apart on
// the fixed scale, effectively invisible. Rescaling each query's own p10-p90
// spread to the full color range (median-anchored min ±10pp floor so a
// near-flat week doesn't divide by ~0 or land back on one flat hue) makes
// whatever real variation exists in *this* dataset use the whole red-green
// range instead of a sliver of it - trading "green always means high
// absolute %" for "green means relatively better this period", which is why
// the legend below prints the actual endpoints rather than leaving 0/100
// implied.
const domain = computed(() => {
  const values = props.cells
    .filter((c) => c.samples > 0 && c.availablePct !== null)
    .map((c) => c.availablePct)
    .sort((a, b) => a - b);
  if (!values.length) return { min: 0, max: 100 };
  const min = percentile(values, 0.1);
  const max = percentile(values, 0.9);
  if (max - min < 5) {
    const mid = (min + max) / 2;
    return { min: Math.max(0, mid - 10), max: Math.min(100, mid + 10) };
  }
  return { min, max };
});

function relativeColor(pct) {
  if (pct === null || pct === undefined) return '#f3f4f6';
  const { min, max } = domain.value;
  const normalized = ((pct - min) / (max - min)) * 100;
  return availabilityColor(Math.max(0, Math.min(100, normalized)));
}

// A cell built from 1-2 polls reads exactly as confident as one built from
// thousands under color alone - the sample count was previously tooltip-only.
// Fading low-sample cells (floor at 0.35, not fully transparent - still
// clickable/readable) is a cheap secondary encoding for that without adding
// a second legend or a busier grid.
const maxSamples = computed(() => Math.max(1, ...props.cells.map((c) => c.samples || 0)));

function opacityFor(cell) {
  if (!cell || !cell.samples) return 1;
  return Math.max(0.35, Math.min(1, Math.sqrt(cell.samples / maxSamples.value)));
}

function tooltipFor(weekday, hour) {
  const cell = cellFor(weekday, hour);
  const label = `${WEEKDAY_LABELS[weekday - 1]}, ${hour}:00`;
  if (!cell || cell.samples === 0) return `${label}: нет данных`;
  return `${label}: ${formatPct(cell.availablePct)} доступности (${cell.samples} набл.)`;
}
</script>

<template>
  <div class="heatmap">
    <p v-if="!cells.length" class="hint">Нет данных за выбранный период.</p>
    <template v-else>
      <div class="grid">
        <div class="corner"></div>
        <div v-for="h in HOURS" :key="`h-${h}`" class="hour-label">{{ h }}</div>
        <template v-for="wd in [1, 2, 3, 4, 5, 6, 7]" :key="`row-${wd}`">
          <div class="weekday-label">{{ WEEKDAY_LABELS[wd - 1] }}</div>
          <div
            v-for="h in HOURS"
            :key="`cell-${wd}-${h}`"
            class="cell"
            :title="tooltipFor(wd, h)"
            :style="{
              background: cellFor(wd, h) ? relativeColor(cellFor(wd, h).availablePct) : '#f3f4f6',
              opacity: opacityFor(cellFor(wd, h)),
            }"
          ></div>
        </template>
      </div>
      <div class="legend">
        <span class="legend-label">{{ formatPct(domain.min) }}</span>
        <div
          class="legend-bar"
          :style="{ background: `linear-gradient(to right, ${availabilityColor(0)}, ${availabilityColor(50)}, ${availabilityColor(100)})` }"
        ></div>
        <span class="legend-label">{{ formatPct(domain.max) }}</span>
        <span class="legend-hint">
          цвет — относительно разброса значений за этот период, не абсолютная шкала 0-100%; бледные
          клетки — мало наблюдений
        </span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.heatmap {
  overflow-x: auto;
}

.grid {
  display: grid;
  grid-template-columns: 36px repeat(24, 22px);
  gap: 2px;
  width: max-content;
}

.corner {
  width: 36px;
}

.hour-label {
  font-size: 10px;
  color: #667;
  text-align: center;
}

.weekday-label {
  font-size: 12px;
  color: #445;
  display: flex;
  align-items: center;
}

.cell {
  width: 22px;
  height: 22px;
  border-radius: 3px;
}

.legend {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}

.legend-bar {
  width: 120px;
  height: 10px;
  border-radius: 5px;
}

.legend-label {
  font-size: 11px;
  color: #667;
}

.legend-hint {
  font-size: 11px;
  color: #889;
}

/* Site dark theme (store/theme.js) - .cell's own fill color is computed
   inline from data (:style), unaffected by theme; just the axis labels
   need a lighter shade to stay legible. */
[data-theme='dark'] .hour-label,
[data-theme='dark'] .weekday-label {
  color: #94a3b8;
}

[data-theme='dark'] .legend-label,
[data-theme='dark'] .legend-hint {
  color: #94a3b8;
}
</style>
