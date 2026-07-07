<script setup>
import { computed, ref } from 'vue';
import { availabilityColor, formatMinutes, formatPct } from '../utils/colorScale';

const props = defineProps({
  stations: { type: Array, default: () => [] },
});

const sortKey = ref('availablePct');
const sortDir = ref('asc');

const COLUMNS = [
  { key: 'name', label: 'Станция' },
  { key: 'availablePct', label: 'Доступность' },
  { key: 'noDataPct', label: 'Нет данных' },
  { key: 'outageCount', label: 'Отключений' },
  { key: 'avgOutageMinutes', label: 'Ср. восстановление' },
  { key: 'totalPolls', label: 'Опросов' },
];

function toggleSort(key) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortKey.value = key;
    sortDir.value = 'asc';
  }
}

const sortedStations = computed(() => {
  const dir = sortDir.value === 'asc' ? 1 : -1;
  return [...props.stations].sort((a, b) => {
    let va = a[sortKey.value];
    let vb = b[sortKey.value];
    if (va === null || va === undefined) va = -Infinity;
    if (vb === null || vb === undefined) vb = -Infinity;
    if (typeof va === 'string') return dir * va.localeCompare(vb);
    return dir * (va - vb);
  });
});
</script>

<template>
  <div class="table-wrap">
    <p v-if="!stations.length" class="hint">Нет данных за выбранный период.</p>
    <table v-else>
      <thead>
        <tr>
          <th v-for="col in COLUMNS" :key="col.key" class="sortable" @click="toggleSort(col.key)">
            {{ col.label }}
            <span v-if="sortKey === col.key">{{ sortDir === 'asc' ? '▲' : '▼' }}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="s in sortedStations" :key="s.stationId">
          <td>
            <div>{{ s.name || 'АЗС' }}</div>
            <div class="address">{{ s.address }}</div>
          </td>
          <td :style="{ color: availabilityColor(s.availablePct), fontWeight: 600 }">
            {{ formatPct(s.availablePct) }}
          </td>
          <td>{{ formatPct(s.noDataPct) }}</td>
          <td>{{ s.outageCount }}</td>
          <td>{{ formatMinutes(s.avgOutageMinutes) }}</td>
          <td>{{ s.totalPolls }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.table-wrap {
  overflow-x: auto;
}

.sortable {
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}

.address {
  font-size: 12px;
  color: #667;
}
</style>
