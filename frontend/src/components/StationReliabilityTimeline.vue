<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { stationsApi } from '../api/regions';
import { statusMeta, computeStatusSegments, collapseIsolatedBlips } from '../utils/fuelStatus';
import { formatMinutes } from '../utils/colorScale';

const props = defineProps({
  stationId: { type: String, required: true },
});

const LOOKBACK_DAYS = 7;

const loading = ref(true);
const errorMessage = ref('');
const segments = ref([]);
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
// independently rather than derived from segment edges.
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
    const from = new Date(Date.now() - LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString();
    const history = await stationsApi.history(props.stationId, { from, limit: 5000 });
    if (!history.length) {
      segments.value = [];
      return;
    }
    segments.value = collapseIsolatedBlips(computeStatusSegments(history));
    rangeStart.value = new Date(history[0].polledAt);
    rangeEnd.value = new Date(history[history.length - 1].polledAt);
  } catch (err) {
    errorMessage.value = 'Не удалось загрузить историю';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(() => props.stationId, load);
</script>

<template>
  <div>
    <p v-if="loading">Загрузка...</p>
    <p v-else-if="errorMessage" class="error-text">{{ errorMessage }}</p>
    <p v-else-if="!segments.length" class="hint">Пока нет истории по этой станции.</p>
    <template v-else>
      <div class="timeline-bar">
        <div
          v-for="(seg, i) in segments"
          :key="i"
          class="timeline-segment"
          :style="segmentStyle(seg)"
          :title="segmentTitle(seg)"
        ></div>
      </div>
      <div class="timeline-ticks">
        <span v-for="(tick, i) in dayTicks" :key="i" class="timeline-tick" :style="{ left: `${tick.pct}%` }">
          {{ tick.label }}
        </span>
      </div>
      <p class="hint small">
        АИ-92, АИ-95 — реальные статусы за последние 7 дней сплошной лентой, без усреднения по
        часам; наведите на участок, чтобы увидеть точное время и длительность.
      </p>
    </template>
  </div>
</template>

<style scoped>
.timeline-bar {
  display: flex;
  height: 32px;
  border-radius: 6px;
  overflow: hidden;
  width: 100%;
}

.timeline-segment {
  min-width: 1px;
}

.timeline-ticks {
  position: relative;
  height: 16px;
  margin-top: 2px;
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
