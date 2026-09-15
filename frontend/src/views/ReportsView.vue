<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { formatMinutes, formatPct } from '../utils/colorScale';
import AvailabilityRecoveryChart from '../components/AvailabilityRecoveryChart.vue';
import AvailabilityHeatmap from '../components/AvailabilityHeatmap.vue';
import StationHighlightCards from '../components/StationHighlightCards.vue';
import StationsTable from '../components/StationsTable.vue';
import StationDetailModal from '../components/StationDetailModal.vue';
import { useReportPeriod } from '../composables/useReportPeriod';
import { useReportMetrics } from '../composables/useReportMetrics';
import { useReportSummary } from '../composables/useReportSummary';
import { useStationDetail } from '../composables/useStationDetail';
import { useReportCard } from '../composables/useReportCard';

const route = useRoute();

// The selected date range/preset/bucket size - see useReportPeriod.js.
// onChange (a preset click or a manual datetime-local edit) re-fetches for
// the new range via useReportMetrics' loadMetrics below - referenced here
// before it's declared, which is fine since onChange is only ever called
// later (on user interaction), by which point loadMetrics already exists.
const {
  fromMs,
  toMs,
  fromIso,
  toIso,
  prevFromIso,
  prevToIso,
  bucketHours,
  fromInput,
  toInput,
  activePresetHours,
  setPreset,
  formatRuDateTime,
} = useReportPeriod({ onChange: () => loadMetrics() });

// Region list/selection and the actual metrics fetch for the period above -
// see useReportMetrics.js. onBeforeLoad similarly forward-references
// reportCard.resetReportCard, constructed further below.
const {
  regions,
  selectedRegionId,
  selectedRegion,
  loading,
  errorMessage,
  trendBuckets,
  forecastDirection,
  stations,
  previousStations,
  heatmapCells,
  recoveryTrendBuckets,
  sectionErrors,
  loadRegions,
  loadMetrics,
} = useReportMetrics({
  fromIso,
  toIso,
  prevFromIso,
  prevToIso,
  bucketHours,
  initialRegionId: route.query.region || '',
  onBeforeLoad: () => resetReportCard(),
});

// The KPI cards' weighted-average summary (this period + previous, for the
// delta lines) - see useReportSummary.js.
const {
  summary,
  availabilityDelta,
  outagesDelta,
  recoveryDelta,
  formatSignedPct,
  formatSignedMinutes,
  formatSignedCount,
} = useReportSummary({ stations, previousStations });

const stationsSort = ref('best');
// Reported live: the full ~100-row stations table used to always render
// inline, pushing the share-card section (and anyone who just wants to
// generate/copy the report image) several screens down. Collapsed by
// default - the top-5 highlight cards right above already cover "what's
// good/bad at a glance"; this table's own job (see StationsTable.vue's
// own doc comment) is a deliberate look-up, not something everyone needs
// to scroll past every time. v-if (not v-show) below so the ~100-row
// sort/search table isn't even built until someone actually opens it.
const stationsTableOpen = ref(false);

// Sorted/selected by rankScore (shrunk toward the region's own rate, so a
// station with barely any evidence this period can't win "лучшая"/"худшая"
// purely on a lucky or unlucky small sample), but every printed
// availablePct stays the plain, unshrunk rate - see metricsService.js's
// getStationMetricsUncached for the full rationale (reported live: a
// station with zero interruptions the whole period was printing less than
// 100%, which reads as a bug, not a nuance, since a reader has no way to
// know the number they're looking at was silently adjusted).
const highlightedStations = computed(() => {
  const dir = stationsSort.value === 'best' ? -1 : 1;
  return [...stations.value]
    .filter((s) => s.rankScore !== null)
    .sort((a, b) => dir * (a.rankScore - b.rankScore))
    .slice(0, 5);
});

// Shareable report card - client-side canvas, same approach and UI pattern
// (generate -> preview -> copy/download/share) as the station card in
// StationDetailModal.vue. See useReportCard.js.
const {
  cardUrl,
  copyFeedback,
  cardGenerating,
  cardError,
  clipboardSupported,
  canShareCard,
  resetReportCard,
  generateReportCard,
  copyReportCardToClipboard,
  shareReportCard,
} = useReportCard({
  selectedRegion,
  fromMs,
  toMs,
  fromIso,
  toIso,
  summary,
  trendBuckets,
  recoveryTrendBuckets,
  forecastDirection,
  highlightedStations,
  stationsSort,
});

// Station detail modal, opened from a station name in either table below -
// see useStationDetail.js.
const { detailStation, showDetailModal, detailLoadingId, detailError, openStationDetail, closeDetailModal } =
  useStationDetail();

onMounted(async () => {
  await loadRegions();
  if (selectedRegionId.value) await loadMetrics();
});
</script>

<template>
  <div class="reports-page">
    <div class="page-header">
      <h1>Отчёты</h1>
    </div>

    <div class="controls card">
      <div class="form-row region-select">
        <label>Район</label>
        <select v-if="regions.length" v-model="selectedRegionId" @change="loadMetrics">
          <option v-for="r in regions" :key="r._id" :value="r._id">{{ r.name }}</option>
        </select>
        <div v-else class="skeleton skeleton-select" aria-hidden="true"></div>
      </div>

      <div class="form-row">
        <label>С</label>
        <input type="datetime-local" v-model="fromInput" :disabled="!regions.length" />
        <span class="date-echo">{{ formatRuDateTime(fromMs) }}</span>
      </div>
      <div class="form-row">
        <label>По</label>
        <input type="datetime-local" v-model="toInput" :disabled="!regions.length" />
        <span class="date-echo">{{ formatRuDateTime(toMs) }}</span>
      </div>

      <div class="presets">
        <button
          class="btn secondary"
          :class="{ active: activePresetHours === 24 }"
          :disabled="!regions.length"
          @click="setPreset(24)"
        >
          24ч
        </button>
        <button
          class="btn secondary"
          :class="{ active: activePresetHours === 24 * 7 }"
          :disabled="!regions.length"
          @click="setPreset(24 * 7)"
        >
          7д
        </button>
        <button
          class="btn secondary"
          :class="{ active: activePresetHours === 24 * 30 }"
          :disabled="!regions.length"
          @click="setPreset(24 * 30)"
        >
          30д
        </button>
        <button
          class="btn secondary"
          :class="{ active: activePresetHours === 24 * 90 }"
          :disabled="!regions.length"
          @click="setPreset(24 * 90)"
        >
          90д
        </button>
      </div>

      <button class="btn" :disabled="loading" @click="loadMetrics">
        {{ loading ? 'Загрузка...' : 'Обновить' }}
      </button>
    </div>

    <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>
    <p v-if="detailError" class="error-text">{{ detailError }}</p>

    <div class="kpi-grid">
      <div class="card kpi">
        <div class="kpi-value">{{ formatPct(summary.overallAvailablePct) }}</div>
        <div class="kpi-label">Общая доступность</div>
        <div class="kpi-sublabel">АИ-92, АИ-95</div>
        <div v-if="availabilityDelta !== null" class="kpi-delta" :class="availabilityDelta >= 0 ? 'good' : 'bad'">
          {{ availabilityDelta >= 0 ? '↑' : '↓' }} {{ formatSignedPct(availabilityDelta) }} к пред. периоду
        </div>
      </div>
      <div class="card kpi">
        <div class="kpi-value">{{ summary.stationCount }}</div>
        <div class="kpi-label">Станций в отчёте</div>
      </div>
      <div class="card kpi">
        <div class="kpi-value">{{ summary.totalOutages }}</div>
        <div class="kpi-label">Отключений за период</div>
        <div v-if="outagesDelta !== null" class="kpi-delta" :class="outagesDelta <= 0 ? 'good' : 'bad'">
          {{ outagesDelta > 0 ? '↑' : outagesDelta < 0 ? '↓' : '=' }} {{ formatSignedCount(outagesDelta) }} к пред. периоду
        </div>
      </div>
      <div class="card kpi">
        <div class="kpi-value">{{ formatMinutes(summary.avgRecoveryMinutes) }}</div>
        <div class="kpi-label">Среднее время восстановления</div>
        <div v-if="recoveryDelta !== null" class="kpi-delta" :class="recoveryDelta <= 0 ? 'good' : 'bad'">
          {{ recoveryDelta > 0 ? '↑' : recoveryDelta < 0 ? '↓' : '=' }} {{ formatSignedMinutes(recoveryDelta) }} к пред. периоду
        </div>
      </div>
    </div>

    <AvailabilityRecoveryChart
      :trend-buckets="trendBuckets"
      :recovery-buckets="recoveryTrendBuckets"
      :bucket-hours="bucketHours"
      :direction="forecastDirection"
      :trend-error-message="sectionErrors.trend || sectionErrors.forecast"
      :recovery-error-message="sectionErrors.recoveryTrend"
    />

    <div class="two-col">
      <div class="card section">
        <div class="section-header">
          <h2>{{ stationsSort === 'best' ? 'Лучшие станции' : 'Худшие станции' }}</h2>
          <div class="sort-toggle">
            <button
              class="btn secondary"
              :class="{ active: stationsSort === 'best' }"
              @click="stationsSort = 'best'"
            >
              Лучшие
            </button>
            <button
              class="btn secondary"
              :class="{ active: stationsSort === 'worst' }"
              @click="stationsSort = 'worst'"
            >
              Худшие
            </button>
          </div>
        </div>
        <p v-if="sectionErrors.stations" class="error-text">{{ sectionErrors.stations }}</p>
        <StationHighlightCards
          :stations="highlightedStations"
          :loading-station-id="detailLoadingId"
          :from="fromIso"
          :to="toIso"
          @select="openStationDetail"
        />
      </div>

      <div class="card section">
        <h2>Доступность по дню недели и часу <span class="hint small">(АИ-92, АИ-95)</span></h2>
        <p v-if="sectionErrors.heatmap" class="error-text">{{ sectionErrors.heatmap }}</p>
        <AvailabilityHeatmap :cells="heatmapCells" />
      </div>
    </div>

    <div class="card section">
      <div class="section-header">
        <h2>Все станции <span class="hint small">({{ stations.length }})</span></h2>
        <button type="button" class="btn secondary" @click="stationsTableOpen = !stationsTableOpen">
          {{ stationsTableOpen ? 'Свернуть ▲' : 'Показать ▼' }}
        </button>
      </div>
      <p v-if="sectionErrors.stations" class="error-text">{{ sectionErrors.stations }}</p>
      <StationsTable
        v-if="stationsTableOpen"
        :stations="stations"
        :loading-station-id="detailLoadingId"
        @select="openStationDetail"
      />
    </div>

    <div class="card section">
      <h2>Картинка отчёта для шаринга</h2>
      <p class="hint">
        Собирает KPI, графики динамики и времени восстановления, топ-3 станции текущей вкладки
        (лучшие/худшие) в одну картинку — удобно переслать в чат вместо ссылки на отчёт.
      </p>

      <template v-if="!cardUrl">
        <button type="button" class="btn secondary" :disabled="cardGenerating" @click="generateReportCard">
          {{ cardGenerating ? 'Генерация...' : '🖼 Сгенерировать картинку' }}
        </button>
      </template>
      <template v-else>
        <img :src="cardUrl" alt="Картинка отчёта" class="card-preview" />
        <div class="card-actions">
          <button type="button" class="btn secondary" @click="resetReportCard">Сгенерировать заново</button>
          <button
            v-if="clipboardSupported"
            type="button"
            class="btn secondary"
            @click="copyReportCardToClipboard"
          >
            {{ copyFeedback === 'ok' ? 'Скопировано ✓' : 'Скопировать в буфер' }}
          </button>
          <button v-if="canShareCard" type="button" class="btn secondary" @click="shareReportCard">
            Поделиться
          </button>
          <a :href="cardUrl" download="report-card.png" class="btn">Скачать</a>
        </div>
        <p v-if="!clipboardSupported" class="hint small">
          Этот браузер не поддерживает копирование картинки в буфер обмена — скачайте файл или
          воспользуйтесь «Поделиться».
        </p>
      </template>
      <p v-if="cardError" class="error-text">{{ cardError }}</p>
    </div>

    <StationDetailModal
      v-if="showDetailModal && detailStation"
      :station="detailStation"
      :region-id="selectedRegionId"
      @close="closeDetailModal"
      @changed="loadMetrics"
    />
  </div>
</template>

<style scoped>
.reports-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.page-header h1 {
  font-size: 20px;
  margin: 0;
}

.controls {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}

.region-select select {
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid #ccd2d9;
  min-width: 200px;
}

.presets {
  display: flex;
  gap: 6px;
}

/* Same active-state look as .sort-toggle .btn.active below - one visual
   language for "this button reflects the current state" across the page. */
.presets .btn.active {
  background: #dbeafe;
  color: #1d4ed8;
}

.date-echo {
  font-size: 12px;
  color: #667;
}

[data-theme='dark'] .date-echo {
  color: #94a3b8;
}

.kpi-delta {
  font-size: 12px;
  font-weight: 600;
  margin-top: 6px;
}

.kpi-delta.good {
  color: #16a34a;
}

.kpi-delta.bad {
  color: #dc2626;
}

[data-theme='dark'] .kpi-delta.good {
  color: #4ade80;
}

[data-theme='dark'] .kpi-delta.bad {
  color: #f87171;
}

/* .kpi-grid/.kpi/.kpi-value/.kpi-label moved to main.css - shared with the
   map page's current-state summary. */

.section h2 {
  font-size: 16px;
  margin-top: 0;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}

.section-header h2 {
  margin: 0;
}

.sort-toggle {
  display: flex;
  gap: 6px;
}

.sort-toggle .btn.active {
  background: #dbeafe;
  color: #1d4ed8;
}

.hint.small {
  font-size: 12px;
}

.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

/* Grid items default to min-width: auto, which refuses to shrink narrower
   than their content's intrinsic size - without this, the wider of the two
   cards (station cards with ribbons, or the 24-hour-wide heatmap) would drag
   the whole page into horizontal scroll on a narrow viewport instead of each
   card's own overflow handling taking over. */
.two-col > * {
  min-width: 0;
}

@media (max-width: 900px) {
  .two-col {
    grid-template-columns: 1fr;
  }
}

/* Site dark theme (store/theme.js) - this file's own .region-select border
   and .sort-toggle active state otherwise tie in specificity with
   main.css's generic dark rules and can win on source order alone. */
[data-theme='dark'] .region-select select {
  background: #1e293b;
  color: #e2e8f0;
  border-color: #334155;
}

[data-theme='dark'] .sort-toggle .btn.active,
[data-theme='dark'] .presets .btn.active {
  background: #1e3a5f;
  color: #93c5fd;
}
</style>
