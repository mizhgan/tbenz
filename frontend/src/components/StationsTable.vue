<script setup>
import { computed, ref, watch } from 'vue';
import { availabilityColor, formatMinutes, formatPct } from '../utils/colorScale';

const props = defineProps({
  stations: { type: Array, default: () => [] },
  defaultSortKey: { type: String, default: 'availablePct' },
  defaultSortDir: { type: String, default: 'asc' },
  loadingStationId: { type: String, default: null },
});
const emit = defineEmits(['select']);

const sortKey = ref(props.defaultSortKey);
const sortDir = ref(props.defaultSortDir);

// A parent toggling e.g. "best" vs "worst" changes what default order makes
// sense - follow it, since otherwise the table would keep showing whatever
// order was picked before the toggle, silently ignoring it.
watch(
  () => [props.defaultSortKey, props.defaultSortDir],
  ([key, dir]) => {
    sortKey.value = key;
    sortDir.value = dir;
  }
);

const COLUMNS = [
  { key: 'name', label: 'Станция' },
  // Gasoline only (АИ-92/95), not diesel/gas - see metricsService.js's own
  // doc comment on CORE_FUEL_TYPES.
  { key: 'availablePct', label: 'Доступность (92/95)' },
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
            <button
              type="button"
              class="station-link"
              :disabled="loadingStationId === s.stationId"
              @click="emit('select', s.stationId)"
            >
              {{ s.name || 'АЗС' }}{{ loadingStationId === s.stationId ? '…' : '' }}
            </button>
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

.station-link {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: #2563eb;
  text-align: left;
  cursor: pointer;
}

.station-link:hover {
  text-decoration: underline;
}

.station-link:disabled {
  color: #94a3b8;
  cursor: default;
}
</style>
