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

// The top-5 best/worst are already their own highlight cards elsewhere on
// the page (see StationHighlightCards.vue) - this full table's own real job
// is "find the one station I actually care about" among the rest, which a
// ~100-row list sorted by column alone doesn't really help with. Client-side
// (the whole list is already loaded for the table itself, no extra
// request), matches on name or address since a driver might search either.
const searchQuery = ref('');

const filteredStations = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return props.stations;
  return props.stations.filter(
    (s) => (s.name || '').toLowerCase().includes(q) || (s.address || '').toLowerCase().includes(q)
  );
});

const sortedStations = computed(() => {
  const dir = sortDir.value === 'asc' ? 1 : -1;
  return [...filteredStations.value].sort((a, b) => {
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
  <div>
    <input
      v-if="stations.length"
      v-model="searchQuery"
      type="search"
      class="station-search"
      placeholder="Поиск по названию или адресу..."
    />
    <div class="table-wrap">
      <p v-if="!stations.length" class="hint">Нет данных за выбранный период.</p>
      <p v-else-if="!sortedStations.length" class="hint">Ничего не найдено по запросу «{{ searchQuery }}».</p>
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
  </div>
</template>

<style scoped>
.station-search {
  width: 100%;
  max-width: 360px;
  padding: 8px 10px;
  margin-bottom: 12px;
  border-radius: 6px;
  border: 1px solid #ccd2d9;
  font: inherit;
}

[data-theme='dark'] .station-search {
  background: #1e293b;
  color: #e2e8f0;
  border-color: #334155;
}

/* Same "fade edge only shows while there's more to scroll to" trick as
   AvailabilityHeatmap.vue's own .heatmap (see its doc comment for how/why) -
   with 6 columns plus wrapping multi-line addresses, a phone screen shows
   barely more than the station-name column before this needed it just as
   much. */
.table-wrap {
  overflow-x: auto;
  background:
    linear-gradient(to right, #fff 30%, rgba(255, 255, 255, 0)),
    linear-gradient(to right, rgba(255, 255, 255, 0), #fff 70%) 100% 0,
    linear-gradient(to right, rgba(0, 0, 0, 0.12), rgba(0, 0, 0, 0)),
    linear-gradient(to left, rgba(0, 0, 0, 0.12), rgba(0, 0, 0, 0)) 100% 0;
  background-repeat: no-repeat;
  background-color: #fff;
  background-size: 32px 100%, 32px 100%, 12px 100%, 12px 100%;
  background-position: 0 0, 100% 0, 0 0, 100% 0;
  background-attachment: local, local, scroll, scroll;
}

[data-theme='dark'] .table-wrap {
  background:
    linear-gradient(to right, #0f172a 30%, rgba(15, 23, 42, 0)),
    linear-gradient(to right, rgba(15, 23, 42, 0), #0f172a 70%) 100% 0,
    linear-gradient(to right, rgba(0, 0, 0, 0.4), rgba(0, 0, 0, 0)),
    linear-gradient(to left, rgba(0, 0, 0, 0.4), rgba(0, 0, 0, 0)) 100% 0;
  background-repeat: no-repeat;
  background-color: #0f172a;
  background-size: 32px 100%, 32px 100%, 12px 100%, 12px 100%;
  background-position: 0 0, 100% 0, 0 0, 100% 0;
  background-attachment: local, local, scroll, scroll;
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

/* Site dark theme (store/theme.js) - this file's own .address color and
   .station-link tie in specificity with main.css's generic dark rule and
   can win on source order alone. */
[data-theme='dark'] .address {
  color: #94a3b8;
}

[data-theme='dark'] .station-link {
  color: #7dabf8;
}
</style>
