<script setup>
import { availabilityColor, formatMinutes, formatPct } from '../utils/colorScale';
import StationReliabilityTimeline from './StationReliabilityTimeline.vue';

// Replaces the old StationsTable.vue for this one spot (best/worst
// stations on the reports page) - sorting by column wasn't actually useful
// here (the best/worst toggle already re-sorts by availability, which is
// the only thing that matters for "is this station reliable or not"), and
// a dense table row had no room for a readable ribbon. One card per
// station instead, full width, with its own real 7-day status ribbon
// (StationReliabilityTimeline.vue, same component the station detail
// modal uses) - only ever up to 5 of these at once (see
// ReportsView.vue's own highlightedStations.slice(0, 5)), so 5 parallel
// history fetches is a non-issue.
defineProps({
  stations: { type: Array, default: () => [] },
  loadingStationId: { type: String, default: null },
});
const emit = defineEmits(['select']);
</script>

<template>
  <div class="highlight-cards">
    <p v-if="!stations.length" class="hint">Нет данных за выбранный период.</p>
    <div v-for="s in stations" :key="s.stationId" class="highlight-card">
      <div class="highlight-header">
        <button
          type="button"
          class="station-link"
          :disabled="loadingStationId === s.stationId"
          @click="emit('select', s.stationId)"
        >
          {{ s.name || 'АЗС' }}{{ loadingStationId === s.stationId ? '…' : '' }}
        </button>
        <div class="address">{{ s.address }}</div>
      </div>
      <div class="highlight-stats">
        <div class="stat">
          <span class="stat-value" :style="{ color: availabilityColor(s.availablePct) }">
            {{ formatPct(s.availablePct) }}
          </span>
          <span class="stat-label">Доступность (92/95)</span>
        </div>
        <div class="stat">
          <span class="stat-value">{{ s.outageCount }}</span>
          <span class="stat-label">Отключений</span>
        </div>
        <div class="stat">
          <span class="stat-value">{{ formatMinutes(s.avgOutageMinutes) }}</span>
          <span class="stat-label">Ср. восстановление</span>
        </div>
        <div class="stat">
          <span class="stat-value">{{ formatPct(s.noDataPct) }}</span>
          <span class="stat-label">Нет данных</span>
        </div>
      </div>
      <StationReliabilityTimeline :station-id="s.stationId" />
    </div>
  </div>
</template>

<style scoped>
.highlight-cards {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.highlight-card {
  padding: 16px;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
}

.highlight-header {
  margin-bottom: 12px;
}

.station-link {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  font-weight: 600;
  font-size: 16px;
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

.address {
  font-size: 13px;
  color: #64748b;
  margin-top: 2px;
}

.highlight-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
  margin-bottom: 14px;
}

.stat {
  display: flex;
  flex-direction: column;
}

.stat-value {
  font-weight: 700;
  font-size: 18px;
}

.stat-label {
  font-size: 11px;
  color: #64748b;
}
</style>
