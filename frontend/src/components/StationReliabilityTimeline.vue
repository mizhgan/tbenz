<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { stationsApi } from '../api/regions';
import { statusMeta, fuelTypeLabel, CORE_FUEL_TYPES, computeStatusSegments, collapseIsolatedBlips } from '../utils/fuelStatus';
import { formatMinutes } from '../utils/colorScale';

// from/to (ISO strings) are optional - when the caller has an actual
// period selected (see ReportsView.vue's own from/to date pickers, passed
// down through StationHighlightCards.vue), the ribbon should show exactly
// that period like every other chart on that page already does, not a
// fixed lookback that quietly ignores it. StationDetailModal.vue (no
// period concept of its own) omits them, falling back to LOOKBACK_DAYS.
const props = defineProps({
  stationId: { type: String, required: true },
  from: { type: String, default: null },
  to: { type: String, default: null },
  // The explanatory hint below the ribbon is only worth its space once -
  // StationDetailModal.vue shows exactly one ribbon per station, but
  // StationHighlightCards.vue renders up to 5 of these in a row, where the
  // exact same sentence repeated under every card added nothing.
  showHint: { type: Boolean, default: true },
});

const LOOKBACK_DAYS = 7;

const loading = ref(true);
const errorMessage = ref('');
// One row per core fuel type (see CORE_FUEL_TYPES) rather than one combined
// best-of row - a combined row was strictly less informative (can't tell
// "92 is out but 95 is fine" from "both are out") and duplicated what the
// old, separate "История по видам топлива" section (downsampleEvenly'd,
// only ~40 points regardless of how much real history existed) already
// tried to show, just more crudely. This replaces that section entirely -
// same underlying data, one real (not downsampled) view instead of two
// approximate ones.
const rows = ref([]);
const rangeStart = ref(null);
const rangeEnd = ref(null);

function formatDateTime(date) {
  return new Date(date).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function segmentTitle(seg) {
  return `${statusMeta(seg.status).label}: ${formatDateTime(seg.start)} — ${formatDateTime(seg.end)} (${formatMinutes(seg.durationMinutes)})`;
}

// Width is the segment's literal share of the whole displayed range - no
// bucketing/downsampling (see computeStatusSegments' own doc comment on why
// that turned out unnecessary). min-width in the stylesheet keeps a very
// short segment (a single 15-minute blip) hoverable instead of collapsing
// to nothing.
function segmentStyle(seg) {
  const totalMs = rangeEnd.value - rangeStart.value;
  const widthPct = totalMs > 0 ? ((seg.end - seg.start) / totalMs) * 100 : 0;
  return {
    flex: `0 0 ${widthPct}%`,
    background: statusMeta(seg.status).color,
  };
}

// Day-boundary (local midnight) tick marks for orientation along the bar,
// positioned by percentage - segments themselves follow real poll
// timestamps, which don't line up with midnight, so these are computed
// independently rather than derived from segment edges. Shared by both
// rows (same underlying history, same range for each).
const dayTicks = computed(() => {
  if (!rangeStart.value || !rangeEnd.value) return [];
  const totalMs = rangeEnd.value - rangeStart.value;
  if (totalMs <= 0) return [];
  const ticks = [];
  const d = new Date(rangeStart.value);
  d.setHours(24, 0, 0, 0); // first midnight strictly after rangeStart
  while (d < rangeEnd.value) {
    const pct = ((d - rangeStart.value) / totalMs) * 100;
    ticks.push({ pct, label: d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) });
    d.setDate(d.getDate() + 1);
  }
  return ticks;
});

async function load() {
  loading.value = true;
  errorMessage.value = '';
  try {
    const from = props.from || new Date(Date.now() - LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString();
    const params = { from, limit: 5000 };
    if (props.to) params.to = props.to;
    const history = await stationsApi.history(props.stationId, params);
    if (!history.length) {
      rows.value = [];
      return;
    }
    rows.value = CORE_FUEL_TYPES.map((fuelType) => ({
      fuelType,
      segments: collapseIsolatedBlips(computeStatusSegments(history, [fuelType])),
    }));
    rangeStart.value = new Date(history[0].polledAt);
    rangeEnd.value = new Date(history[history.length - 1].polledAt);
  } catch (err) {
    errorMessage.value = 'Не удалось загрузить историю';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(() => [props.stationId, props.from, props.to], load);
</script>

<template>
  <div>
    <p v-if="loading">Загрузка...</p>
    <p v-else-if="errorMessage" class="error-text">{{ errorMessage }}</p>
    <p v-else-if="!rows.length" class="hint">Пока нет истории по этой станции.</p>
    <template v-else>
      <div v-for="row in rows" :key="row.fuelType" class="timeline-row">
        <div class="timeline-row-label">{{ fuelTypeLabel(row.fuelType) }}</div>
        <div class="timeline-bar">
          <div
            v-for="(seg, i) in row.segments"
            :key="i"
            class="timeline-segment"
            :style="segmentStyle(seg)"
            :title="segmentTitle(seg)"
          ></div>
        </div>
      </div>
      <div class="timeline-ticks">
        <span v-for="(tick, i) in dayTicks" :key="i" class="timeline-tick" :style="{ left: `${tick.pct}%` }">
          {{ tick.label }}
        </span>
      </div>
      <p v-if="showHint" class="hint small">
        Реальные статусы за {{ from ? 'выбранный период' : 'последние 7 дней' }} сплошной
        лентой, без усреднения по часам; наведите на участок, чтобы увидеть точное время и
        длительность.
      </p>
    </template>
  </div>
</template>

<style scoped>
.timeline-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.timeline-row-label {
  flex: 0 0 44px;
  font-size: 12px;
  font-weight: 600;
  color: #475569;
}

.timeline-bar {
  display: flex;
  flex: 1;
  height: 22px;
  border-radius: 5px;
  overflow: hidden;
}

.timeline-segment {
  min-width: 1px;
}

.timeline-ticks {
  position: relative;
  height: 16px;
  margin-top: 4px;
  margin-left: 52px;
  font-size: 10px;
  color: #64748b;
}

.timeline-tick {
  position: absolute;
  transform: translateX(-50%);
  white-space: nowrap;
}

.hint.small {
  font-size: 11px;
  margin-top: 6px;
}
</style>
