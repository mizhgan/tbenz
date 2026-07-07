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
    <div v-else class="grid">
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
            background: cellFor(wd, h) ? availabilityColor(cellFor(wd, h).availablePct) : '#f3f4f6',
          }"
        ></div>
      </template>
    </div>
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
</style>
