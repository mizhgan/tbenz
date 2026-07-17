<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import L from 'leaflet';
import { useMapBasemapStore, BASEMAP_STYLES, resolveBasemapUrl } from '../store/mapBasemap';
import { useThemeStore } from '../store/theme';
import ExportPanel from '../components/ExportPanel.vue';
import StationDetailModal from '../components/StationDetailModal.vue';
import MapShareCardModal from '../components/MapShareCardModal.vue';
import { statusMeta, fuelTypeLabel } from '../utils/fuelStatus';
import { formatPct, availabilityColor } from '../utils/colorScale';
import { useRegionSnapshot } from '../composables/useRegionSnapshot';
import { useMapFilters, STATUS_KEYS } from '../composables/useMapFilters';
import { useMapMarkers } from '../composables/useMapMarkers';
import { useMapExport } from '../composables/useMapExport';
import { useMapShareCard } from '../composables/useMapShareCard';

// leaflet-image (used for the export panel below) expects a global `L`, as
// most pre-ES-module Leaflet plugins do.
window.L = L;

const route = useRoute();
const basemapStore = useMapBasemapStore();
const themeStore = useThemeStore();

// Region selection, time range/slider, and the station snapshot at
// whichever moment is currently selected - see useRegionSnapshot.js.
const {
  regions,
  selectedRegionId,
  range,
  atMs,
  stations,
  loadingStations,
  initialLoading,
  errorMessage,
  liveMode,
  hasRange,
  atLabel,
  selectedRegion,
  loadRegions,
  loadRange,
  loadSnapshot,
  handleSliderInput,
  handleSliderChange,
  jumpToNow,
  formatDateTime,
} = useRegionSnapshot(route.query.region || '');

// Status/fuel-type/brand filtering, derived from `stations` above - see
// useMapFilters.js.
const {
  statusFilters,
  selectedFuelTypes,
  availableFuelTypes,
  effectiveStatus,
  badgeFuelLabel,
  currentSummary,
  brandFilters,
  brandSearch,
  availableBrands,
  visibleBrandOptions,
  setAllBrands,
  brandButtonRef,
  brandPanelRef,
  brandPanelOpen,
  brandPanelPos,
  toggleBrandPanel,
  closeBrandPanel,
  hasActiveExtraFilters,
  resetExtraFilters,
  resetForNewRegion,
  filteredStations,
  brandOf,
} = useMapFilters(stations);

// Off-canvas filters/region/slider panel over the map (see .drawer-panel) -
// closed by default so the map itself is the first thing a visitor sees
// full-bleed, not a control bar. Auto-opens once on the very first load if
// there's no data yet (see onMounted below) so a first-time visitor whose
// region genuinely has nothing to show isn't left staring at an empty map
// with no visible way to find out why.
const drawerOpen = ref(false);

const mapContainer = ref(null);
// Plain (non-reactive) holder, not a ref - passed by reference into the
// composables below, which are constructed here in setup(), before the
// Leaflet map itself exists (that only happens once onMounted runs and
// mapContainer.value is a real DOM node). Any function inside those
// composables that reads mapState.map/mapState.markersLayer only actually
// runs later, by which point onMounted has populated it - see
// useMapMarkers.js's own doc comment for the full reasoning.
const mapState = { map: null, markersLayer: null, tileLayer: null };
// Drives .leaflet-map--dark-filter (see this file's own <style>) - "Обычная"
// (OSM's own tiles) has no dark-native variant to switch to the way
// "Контрастная" swaps to Carto's dark_all, so dark site theme + this style
// needs a CSS approximation instead (see applyBasemapStyle's own comment
// on the exact filter values). Light theme needs no filter at all here -
// "Обычная" is meant to be genuinely standard, unmodified OSM in that case.
const useDarkTileFilter = ref(false);
let resizeObserver = null;

// Marker/popup rendering - watches `filteredStations` above and redraws
// automatically, see useMapMarkers.js.
const {
  selectedStation,
  showDetailModal,
  hasFitted,
  closeDetailModal,
  updateMarkerRadii,
} = useMapMarkers({
  mapState,
  stationsRef: stations,
  filteredStationsRef: filteredStations,
  effectiveStatus,
  badgeFuelLabelRef: badgeFuelLabel,
});

// "Экспорт анимации" - see useMapExport.js.
const {
  showExportPanel,
  exportGenerating,
  exportFetchProgress,
  exportEncodeProgress,
  exportResultUrl,
  exportResultMimeType,
  exportError,
  exportCanShare,
  exportFrameInfo,
  videoExportSupported,
  openExportPanel,
  resetExportResult,
  closeExportPanel,
  handleShareExport,
  handleGenerateExport,
} = useMapExport({ mapState, selectedRegionId, range, statusFilters, brandFilters, effectiveStatus, brandOf });

// "Картинка для шаринга" - see useMapShareCard.js.
const {
  showShareCard,
  shareCardGenerating,
  shareCardError,
  shareCardUrl,
  shareCardCopyFeedback,
  shareCardCanShare,
  shareCardClipboardSupported,
  generateShareCard,
  openShareCard,
  closeShareCard,
  copyShareCardToClipboard,
  shareShareCard,
} = useMapShareCard({
  mapState,
  stationsRef: stations,
  statusFilters,
  brandFilters,
  effectiveStatus,
  brandOf,
  selectedRegionRef: selectedRegion,
  currentSummaryRef: currentSummary,
  badgeFuelLabelRef: badgeFuelLabel,
});

// Swaps the whole tile provider - the header switcher
// (App.vue/store/mapBasemap.js) picks between plain OSM and Carto, which
// needs a different URL/attribution entirely, not just a style tweak on
// the same tiles. Re-run whenever *either* the basemap style or the site
// theme changes (see the two watchers in onMounted) - "contrast" resolves
// to a different Carto variant per theme (resolveBasemapUrl), so a theme
// flip needs to swap tiles even if the style itself didn't change.
function applyBasemapStyle() {
  if (!mapState.map) return;
  const styleKey = basemapStore.style;
  const cfg = BASEMAP_STYLES[styleKey] || BASEMAP_STYLES.standard;
  if (mapState.tileLayer) mapState.tileLayer.remove();
  mapState.tileLayer = L.tileLayer(resolveBasemapUrl(styleKey, themeStore.theme), {
    attribution: cfg.attribution,
    subdomains: cfg.subdomains,
    maxZoom: 19,
    crossOrigin: true,
  }).addTo(mapState.map);
  // "Контрастная" needs no filter regardless of theme (it already swapped
  // to the matching Carto variant above) - only "Обычная" in dark theme
  // does, see .leaflet-map--dark-filter's own doc comment for why.
  useDarkTileFilter.value = styleKey === 'standard' && themeStore.theme === 'dark';
}

async function handleRegionChange() {
  selectedStation.value = null;
  closeDetailModal();
  hasFitted.value = false;
  resetForNewRegion();
  await loadRange();
  await loadSnapshot();
}

onMounted(async () => {
  // zoomControl: false + added back at bottomright - Leaflet's default
  // topleft position would sit right under the new drawer-toggle button
  // (see .drawer-toggle/.status-badge in the template), which also lives in
  // that corner now that the old control bar no longer pushes the map down.
  mapState.map = L.map(mapContainer.value, { zoomControl: false }).setView([55.75, 37.62], 6);
  L.control.zoom({ position: 'bottomright' }).addTo(mapState.map);
  // Leaflet's own "Leaflet" link in the attribution control is just its
  // default branding, not a license requirement - drop it. The OpenStreetMap
  // attribution added by the tile layer below stays: it's required by OSM's
  // tile usage policy for their free tiles, unlike the Leaflet prefix.
  mapState.map.attributionControl.setPrefix(false);
  applyBasemapStyle();
  // Live-reacts to the header switchers (App.vue) even while already
  // looking at the map - registered here (not at module scope) so they can
  // safely assume `mapState.map` already exists; watch() only fires on
  // *future* changes (no `immediate`), so there's no risk of running before
  // that.
  watch(() => basemapStore.style, applyBasemapStyle);
  watch(() => themeStore.theme, applyBasemapStyle);
  mapState.markersLayer = L.layerGroup().addTo(mapState.map);
  mapState.map.on('zoomend', updateMarkerRadii);

  // The map's container is stretched by flex layout to match the sidebar's
  // height (see .map-body), which grows when a station is selected (more
  // details, forecast, history chart). Leaflet has no way to know its
  // container was resized by something other than itself, so without this
  // it keeps clipping tiles/markers to whatever size it was at
  // construction time - invalidateSize() tells it to re-measure.
  resizeObserver = new ResizeObserver(() => {
    mapState.map.invalidateSize();
  });
  resizeObserver.observe(mapContainer.value);

  try {
    await loadRegions();
    if (selectedRegionId.value) {
      await loadRange();
      await loadSnapshot();
    }
  } finally {
    initialLoading.value = false;
    // A region with no historical data yet shows its explanation inside the
    // drawer (see the template) - open it automatically this one time so a
    // first-time visitor actually sees why the map looks empty, instead of
    // that message sitting behind an unopened toggle with no hint anything
    // needs attention.
    if (!hasRange.value) drawerOpen.value = true;
  }
});

onBeforeUnmount(() => {
  if (resizeObserver) resizeObserver.disconnect();
  if (mapState.map) mapState.map.remove();
});
</script>

<template>
  <div class="map-page">
    <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>

    <div class="map-wrap">
      <div ref="mapContainer" class="leaflet-map" :class="{ 'leaflet-map--dark-filter': useDarkTileFilter }"></div>

      <!-- Always-visible entry point into the drawer below - region,
           slider, export/share etc. still live behind it, so the map
           itself (not a control bar) is what a visitor sees first. The
           status checkboxes are the one exception: common enough to act on
           that they sit right next to the toggle instead, in their own
           sibling element (not nested inside the button) so clicking them
           toggles a status without also opening/closing the drawer. -->
      <div class="toggle-bar">
        <button
          type="button"
          class="drawer-toggle"
          :class="{ active: drawerOpen }"
          :aria-expanded="drawerOpen"
          @click="drawerOpen = !drawerOpen"
        >
          <span class="drawer-toggle-icon">☰</span>
          Фильтры
        </button>

        <div v-if="currentSummary.total" class="quick-status-filters">
          <label v-for="key in STATUS_KEYS" :key="key" class="quick-status-checkbox" :title="statusMeta(key).label">
            <input type="checkbox" v-model="statusFilters[key]" />
            <span class="dot" :style="{ background: statusMeta(key).color }"></span>
          </label>
        </div>

        <!-- Fuel-type/brand filters (picked inside the drawer) have no
             other always-visible trace once it's closed - this is that
             trace, and a one-click way out of it. -->
        <button
          v-if="hasActiveExtraFilters"
          type="button"
          class="extra-filter-badge"
          title="Выбраны виды топлива и/или сети - нажмите, чтобы сбросить"
          @click="resetExtraFilters"
        >
          Фильтр применён ✕
        </button>
      </div>

      <!-- Compact glanceable summary that stays visible even with the
           drawer closed - the one piece of the old control bar worth never
           fully hiding, see currentSummary's own doc comment. Color scales
           with the actual percentage (red -> yellow -> green, see
           availabilityColor) instead of always being the "available"
           status's own green - a badge that's always green regardless of
           whether it's showing 13% or 90% isn't actually telling you
           anything at a glance. -->
      <Transition name="fade">
        <div
          v-if="currentSummary.total"
          class="status-badge"
          :style="{ borderTopColor: availabilityColor(currentSummary.availablePct) }"
        >
          <span class="status-badge-pct-row">
            <span
              v-if="loadingStations"
              class="status-badge-spinner"
              :style="{ borderTopColor: availabilityColor(currentSummary.availablePct) }"
            ></span>
            <strong :style="{ color: availabilityColor(currentSummary.availablePct) }">
              {{ formatPct(currentSummary.availablePct) }}
            </strong>
          </span>
          <span class="hint small">{{ badgeFuelLabel }}</span>
          <span class="hint small">{{ filteredStations.length }} из {{ currentSummary.total }}</span>
        </div>
      </Transition>

      <Transition name="fade">
        <div v-if="drawerOpen" class="drawer-backdrop" @click="drawerOpen = false"></div>
      </Transition>

      <Transition name="slide">
        <div v-if="drawerOpen" class="drawer-panel card">
          <div class="drawer-header">
            <h2>Фильтры</h2>
            <button type="button" class="link-btn close-btn" @click="drawerOpen = false">✕</button>
          </div>

          <div class="form-row region-select">
            <label>Район</label>
            <select v-if="regions.length" v-model="selectedRegionId" @change="handleRegionChange">
              <option v-for="r in regions" :key="r._id" :value="r._id">{{ r.name }}</option>
            </select>
            <div v-else class="skeleton skeleton-select" aria-hidden="true"></div>
          </div>

          <Transition name="fade" mode="out-in">
            <div v-if="hasRange" key="controls" class="controls-loaded">
              <div class="slider-block">
                <label>Момент времени: {{ atLabel }}</label>
                <input
                  type="range"
                  :min="range.from"
                  :max="range.to"
                  step="60000"
                  v-model.number="atMs"
                  @input="handleSliderInput"
                  @change="handleSliderChange"
                />
                <div class="slider-labels">
                  <span>{{ formatDateTime(range.from) }}</span>
                  <span>{{ formatDateTime(range.to) }}</span>
                </div>
              </div>
              <button class="btn secondary" :class="{ active: liveMode }" @click="jumpToNow">
                {{ liveMode ? '● Живой режим' : 'К текущему моменту' }}
              </button>
              <button class="btn secondary" @click="openExportPanel">🎞 Экспорт анимации</button>
              <button class="btn secondary" @click="openShareCard">🖼 Картинка для шаринга</button>

              <div class="filter-block">
                <template v-if="availableFuelTypes.length">
                  <span class="filter-label">Виды топлива (по умолчанию — бензин, влияет на цвет точек и процент):</span>
                  <label v-for="ft in availableFuelTypes" :key="ft" class="filter-checkbox">
                    <input type="checkbox" v-model="selectedFuelTypes" :value="ft" />
                    {{ fuelTypeLabel(ft) }}
                  </label>
                </template>

                <span class="filter-label">Показывать:</span>
                <label v-for="key in STATUS_KEYS" :key="key" class="filter-checkbox">
                  <input type="checkbox" v-model="statusFilters[key]" />
                  <span class="dot" :style="{ background: statusMeta(key).color }"></span>
                  {{ statusMeta(key).label }}
                </label>

                <button
                  v-if="availableBrands.length"
                  ref="brandButtonRef"
                  type="button"
                  class="btn secondary brand-filter-toggle"
                  :class="{ active: brandPanelOpen }"
                  @click="toggleBrandPanel"
                >
                  Сети
                  <span v-if="availableBrands.some((b) => brandFilters[b] === false)" class="brand-filter-badge">
                    фильтр
                  </span>
                </button>
              </div>
            </div>
            <div v-else-if="initialLoading" key="skeleton" class="controls-skeleton" aria-hidden="true">
              <div class="skeleton skeleton-slider"></div>
              <div class="skeleton skeleton-btn"></div>
              <div class="skeleton skeleton-btn"></div>
              <div class="skeleton skeleton-chip" v-for="n in 4" :key="n"></div>
            </div>
            <p v-else key="empty" class="hint">
              Для этого района ещё нет исторических данных. Опросите его на странице «Районы».
            </p>
          </Transition>

          <Transition name="fade">
            <div v-if="currentSummary.total" class="current-state-inline">
              <span class="current-state-label"> Сейчас · {{ badgeFuelLabel }}: </span>
              <strong class="current-state-pct" :style="{ color: statusMeta('available').color }">
                {{ formatPct(currentSummary.availablePct) }}
              </strong>
              <span class="current-state-item">
                <span class="dot" :style="{ background: statusMeta('available').color }"></span>
                {{ currentSummary.stationCounts.available }}
              </span>
              <span class="current-state-item">
                <span class="dot" :style="{ background: statusMeta('maybe_available').color }"></span>
                {{ currentSummary.stationCounts.maybe_available }}
              </span>
              <span class="current-state-item">
                <span class="dot" :style="{ background: statusMeta('not_available').color }"></span>
                {{ currentSummary.stationCounts.not_available }}
              </span>
              <span class="current-state-item">
                <span class="dot" :style="{ background: statusMeta('no_data').color }"></span>
                {{ currentSummary.stationCounts.no_data }}
              </span>
              <span class="current-state-shown hint small">
                показано {{ filteredStations.length }} из {{ stations.length }}
              </span>
            </div>
          </Transition>
        </div>
      </Transition>
    </div>

    <Teleport to="body">
      <div v-if="brandPanelOpen" class="brand-filter-overlay" @click.self="closeBrandPanel">
        <div
          ref="brandPanelRef"
          class="brand-filter-panel card"
          :style="{ top: `${brandPanelPos.top}px`, left: `${brandPanelPos.left}px` }"
        >
          <div class="brand-filter-actions">
            <input
              v-model="brandSearch"
              type="text"
              class="brand-search"
              placeholder="Поиск сети..."
            />
            <button type="button" class="btn secondary" @click="setAllBrands(true)">Все</button>
            <button type="button" class="btn secondary" @click="setAllBrands(false)">Ничего</button>
          </div>
          <div class="brand-filter-list">
            <label v-for="brand in visibleBrandOptions" :key="brand" class="filter-checkbox">
              <input type="checkbox" v-model="brandFilters[brand]" />
              {{ brand }}
            </label>
            <p v-if="!visibleBrandOptions.length" class="hint">Ничего не найдено</p>
          </div>
        </div>
      </div>
    </Teleport>

    <StationDetailModal
      v-if="showDetailModal && selectedStation"
      :station="selectedStation"
      :region-id="selectedRegionId"
      :selected-fuel-types="selectedFuelTypes"
      @close="closeDetailModal"
      @changed="loadSnapshot"
    />

    <ExportPanel
      v-if="showExportPanel"
      :visible="showExportPanel"
      :range-from-ms="range.from"
      :range-to-ms="range.to"
      :generating="exportGenerating"
      :fetch-progress="exportFetchProgress"
      :encode-progress="exportEncodeProgress"
      :result-url="exportResultUrl"
      :result-mime-type="exportResultMimeType"
      :video-supported="videoExportSupported"
      :can-share="exportCanShare"
      :frame-info="exportFrameInfo"
      :error-message="exportError"
      @close="closeExportPanel"
      @generate="handleGenerateExport"
      @reset="resetExportResult"
      @share="handleShareExport"
    />

    <MapShareCardModal
      v-if="showShareCard"
      :generating="shareCardGenerating"
      :result-url="shareCardUrl"
      :can-share="shareCardCanShare"
      :clipboard-supported="shareCardClipboardSupported"
      :copy-feedback="shareCardCopyFeedback"
      :error-message="shareCardError"
      @close="closeShareCard"
      @regenerate="generateShareCard"
      @copy="copyShareCardToClipboard"
      @share="shareShareCard"
    />
  </div>
</template>

<style scoped>
.map-page {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

/* .map-page dropped its gap when it went full-bleed (the map itself now
   fills all remaining space) - this is the one sibling that still needs
   breathing room from the map below it. */
.map-page > .error-text {
  margin: 8px 12px;
}

/* Floating entry point for the drawer below - top-left, the corner
   Leaflet's own zoom control used to occupy (moved to bottomright in
   onMounted specifically to free this spot up, see the map init code). */
.toggle-bar {
  position: absolute;
  top: 12px;
  left: 12px;
  /* Wide enough to wrap its children onto a second row instead of
     overflowing once the extra-filter badge appears, without claiming the
     whole strip for itself - pointer-events: none plus opting each actual
     child back in below is what stops this now-wider (but still visually
     empty on the right) box from swallowing clicks meant for the map. */
  right: 12px;
  z-index: 460;
  display: flex;
  align-items: stretch;
  flex-wrap: wrap;
  gap: 8px;
  pointer-events: none;
}

.toggle-bar > * {
  pointer-events: auto;
}

.drawer-toggle {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 16px;
  background: #fff;
  border: none;
  border-radius: 8px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  cursor: pointer;
  font-size: 14px;
  font-weight: 600;
  font-family: inherit;
  color: #14213d;
}

.drawer-toggle:hover {
  background: #f8fafc;
}

.drawer-toggle.active {
  background: #2563eb;
  color: #fff;
}

.drawer-toggle-icon {
  font-size: 15px;
  line-height: 1;
}

/* Quick-access status checkboxes next to the toggle - a sibling, not a
   child of the button, specifically so clicking a checkbox toggles that
   status without also firing the button's own click handler (which would
   open/close the drawer). Mirrors the full .filter-checkbox list still
   inside the drawer - same statusFilters state, just faster to reach for
   the common case of hiding/showing a status without opening anything. */
.quick-status-filters {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
}

.quick-status-checkbox {
  display: flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
}

.quick-status-checkbox input[type='checkbox'] {
  margin: 0;
  cursor: pointer;
}

/* Only sign, with the drawer closed, that a fuel-type/brand filter is
   narrowing what's shown - see hasActiveExtraFilters. Doubles as the
   reset control, so it's a <button>, not a static label. */
.extra-filter-badge {
  display: flex;
  align-items: center;
  padding: 0 14px;
  background: #fff7ed;
  color: #c2410c;
  border: 1px solid #fdba74;
  border-radius: 8px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
}

.extra-filter-badge:hover {
  background: #ffedd5;
}

/* Narrow phones: toggle-bar + status-badge (both absolutely positioned,
   independent of each other) can together exceed the viewport width and
   overlap - tighten spacing rather than hide anything, so all the same
   controls stay reachable. */
@media (max-width: 480px) {
  .toggle-bar {
    gap: 6px;
  }

  .drawer-toggle {
    padding: 9px 12px;
  }

  .quick-status-filters {
    gap: 6px;
    padding: 0 8px;
  }

  .extra-filter-badge {
    padding: 0 10px;
    font-size: 12px;
  }
}

/* The one piece of the old control bar that stays visible with the drawer
   closed - top-right, mirroring the toggle's corner on the left. */
.status-badge {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 460;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  min-width: 64px;
  padding: 6px 14px 8px;
  background: #fff;
  border-radius: 8px;
  border-top: 3px solid;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
}

.status-badge strong {
  font-size: 19px;
  line-height: 1.3;
}

/* Loading state: a small spinner of its own (fixed 12x12 square, not
   wrapped around the percentage text) sitting to the left of it - two
   earlier attempts here (a ring around the text, a shimmer on the top
   border) both turned out to be too subtle or visually broken to actually
   read as "this is refreshing" at a glance; a plain small spinner next to
   the number is the one everyone already recognizes. */
.status-badge-pct-row {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.status-badge-spinner {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  border: 2px solid rgba(0, 0, 0, 0.12);
  border-radius: 50%;
  animation: spinner-rotate 0.7s linear infinite;
}

.drawer-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(15, 23, 42, 0.35);
  /* Above Leaflet's own controls (its panes/controls go up to z-index 1000)
     - on a narrow screen the drawer can approach the map's full width, and
     should fully cover the zoom control underneath rather than let it poke
     through at a higher stacking level. */
  z-index: 1200;
}

.drawer-panel {
  position: absolute;
  inset: 0 auto 0 0;
  width: 360px;
  max-width: 88vw;
  overflow-y: auto;
  z-index: 1210;
  border-radius: 0 10px 10px 0;
  box-shadow: 3px 0 16px rgba(0, 0, 0, 0.3);
}

.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.drawer-header h2 {
  margin: 0;
  font-size: 17px;
}

/* Vue <Transition name="slide"> - the drawer sliding in/out from the left,
   separate from the shared .fade-* pair (main.css) which the backdrop and
   status badge use instead. */
.slide-enter-active,
.slide-leave-active {
  transition: transform 0.22s ease;
}

.slide-enter-from,
.slide-leave-to {
  transform: translateX(-100%);
}

.region-select select {
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid #ccd2d9;
  width: 100%;
}

/* A narrow ~360px drawer, unlike the old full-width control bar - everything
   stacks in one column instead of wrapping across a wide row. */
.controls-loaded {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 14px;
  margin-top: 16px;
}

/* Same shape as .controls-loaded's real content once loaded (slider +
   2 buttons + 4 filter rows) - a placeholder skeleton rather than a blank
   gap while the region/range/snapshot requests are still in flight. */
.controls-skeleton {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 12px;
  margin-top: 16px;
}

.skeleton-slider {
  width: 100%;
  height: 40px;
}

.skeleton-btn {
  width: 100%;
  height: 34px;
}

.skeleton-chip {
  width: 70%;
  height: 20px;
  border-radius: 4px;
}

.controls-loaded > .btn,
.filter-block .btn {
  width: 100%;
}

/* Replaces the old full KPI-grid card: same numbers, but a compact block
   folded into the drawer instead of a separate card - the .status-badge
   above already covers "at a glance", this is the detail behind it. */
.current-state-inline {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 14px;
  width: 100%;
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid #eee;
  font-size: 13px;
  color: #445;
}

.current-state-label {
  color: #667;
  width: 100%;
}

.current-state-pct {
  font-size: 16px;
}

.current-state-item {
  display: flex;
  align-items: center;
  gap: 5px;
}

.current-state-shown {
  width: 100%;
}

.slider-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}

.slider-block input[type='range'] {
  width: 100%;
}

.slider-labels {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: #667;
}

.btn.secondary.active {
  background: #dbeafe;
  color: #1d4ed8;
}

/* Fills .map-wrap edge-to-edge (see .content--full-bleed / .map-page) -
   no card styling since this is the whole page now, not a card floating
   in one. */
.leaflet-map {
  width: 100%;
  height: 100%;
}

/* Dark-theme approximation for "Обычная" - unlike "Контрастная" (which
   just swaps to Carto's own dark_all tiles), OSM has no dark-native
   variant to switch to, so picking dark site theme while still on this
   style would otherwise leave a bright light-mode map sitting in the
   middle of an otherwise-dark page (light theme needs nothing here at all
   - "Обычная" there is meant to be genuinely standard, unmodified OSM).
   Uses the standard CSS "invert the whole tile" trick (invert flips
   light<->dark; hue-rotate(180deg) un-does the resulting hue shift, e.g.
   keeps roads looking roughly road-colored instead of inverted-cyan;
   brightness/contrast/saturate tone the result down to a muted dark map,
   not a harsh photo-negative). Imperfect - a real dark-styled tileset
   (like Carto's dark_all) always looks better - but a reasonable
   approximation for the one style that doesn't have one. :deep() targets
   .leaflet-tile-pane specifically, a sibling of the marker/popup panes,
   not an ancestor of them, so markers/popups stay unaffected. */
.leaflet-map--dark-filter :deep(.leaflet-tile-pane) {
  filter: invert(1) hue-rotate(180deg) brightness(0.85) contrast(0.9) saturate(0.6);
}

.map-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
}

/* Station quick-info popup on marker click, replacing the old always-on
   sidebar - :deep() because Leaflet injects this as raw HTML outside Vue's
   render tree (see buildPopupHtml in the script), so it never gets the
   scoped data-v- attribute these selectors would otherwise need. */
:deep(.station-popup) {
  font-size: 13px;
  min-width: 180px;
}

:deep(.popup-title) {
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 2px;
}

:deep(.popup-address) {
  color: #667;
  margin-bottom: 6px;
}

:deep(.popup-status) {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  margin-bottom: 6px;
}

/* Compact АИ-92/АИ-95 history ribbon (last 24h - see useMapMarkers.js's
   buildRibbonHtml) - a hand-built raw-HTML equivalent of
   StationReliabilityTimeline.vue's own ribbon, scaled down to fit here.
   Loads lazily (only once a popup is actually opened) and shows this
   placeholder styling until then. */
:deep(.popup-ribbon) {
  margin-bottom: 8px;
}

:deep(.popup-ribbon-row) {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 2px;
}

:deep(.popup-ribbon-label) {
  flex: 0 0 34px;
  font-size: 10px;
  font-weight: 600;
  color: #475569;
}

:deep(.popup-ribbon-bar) {
  display: flex;
  flex: 1;
  height: 14px;
  border-radius: 3px;
  overflow: hidden;
  background: #e2e8f0;
}

:deep(.popup-ribbon-segment) {
  min-width: 1px;
}

:deep(.popup-ribbon-hint) {
  margin-top: 2px;
  font-size: 10px;
  color: #94a3b8;
  text-align: right;
}

:deep(.popup-ribbon-empty) {
  font-size: 11px;
  color: #94a3b8;
  padding: 4px 0;
}

:deep(.popup-fuel-list) {
  max-height: 140px;
  overflow-y: auto;
  border-top: 1px solid #eee;
  padding-top: 6px;
  margin-bottom: 8px;
}

:deep(.popup-fuel-row) {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
}

:deep(.popup-dot) {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex-shrink: 0;
}

:deep(.popup-sources) {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 11px;
  color: #667;
  margin-bottom: 8px;
}

:deep(.popup-source-chip) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  background: #f1f5f9;
  border-radius: 999px;
}

:deep(.popup-sources-warn) {
  color: #b45309;
  font-weight: 600;
}

:deep(.popup-hint) {
  color: #667;
  font-size: 12px;
  margin-bottom: 8px;
}

:deep(.popup-detail-btn) {
  width: 100%;
}

/* Phase 1 of the site's dark theme (store/theme.js) - this page's own
   chrome plus the marker popup, not yet a site-wide pass (see the store's
   own doc comment). Deliberately doesn't touch the shared .card/.btn/.hint
   rules in main.css (every other, still-light page reuses those) - each
   selector below overrides its own specific class instead, and since this
   is a scoped <style> block, an override like `.hint` here only ever
   matches .hint elements this component itself renders, never another
   component's - safe to reuse the same class names without leaking styling
   onto other pages. Gated on [data-theme="dark"] on <html> (set by
   App.vue's watcher) rather than a local prop, so it also reaches the
   marker popup's raw Leaflet-managed HTML the same way. */
[data-theme='dark'] .drawer-toggle {
  background: #1e293b;
  color: #e2e8f0;
}

[data-theme='dark'] .drawer-toggle:hover {
  background: #253449;
}

[data-theme='dark'] .drawer-toggle.active {
  background: #2563eb;
  color: #fff;
}

[data-theme='dark'] .quick-status-filters {
  background: #1e293b;
  color: #e2e8f0;
}

[data-theme='dark'] .extra-filter-badge {
  background: #422006;
  color: #fdba74;
  border-color: #7c4a12;
}

[data-theme='dark'] .extra-filter-badge:hover {
  background: #52290a;
}

[data-theme='dark'] .status-badge {
  background: #1e293b;
  color: #e2e8f0;
}

[data-theme='dark'] .status-badge-spinner {
  border-color: rgba(255, 255, 255, 0.18);
}

[data-theme='dark'] .drawer-backdrop {
  background: rgba(0, 0, 0, 0.55);
}

[data-theme='dark'] .drawer-panel {
  background: #0f172a;
  color: #e2e8f0;
  /* Lets native form controls (the region <select>, checkboxes, the date
     slider) pick reasonable dark-mode colors on their own instead of
     staying styled for a light page around them - cheaper and more
     consistent across browsers than manually reskinning each one. */
  color-scheme: dark;
}

[data-theme='dark'] .drawer-header h2 {
  color: #fff;
}

[data-theme='dark'] .hint {
  color: #94a3b8;
}

[data-theme='dark'] .region-select select {
  background: #1e293b;
  color: #e2e8f0;
  border-color: #334155;
}

[data-theme='dark'] .btn.secondary {
  background: #334155;
  color: #e2e8f0;
}

[data-theme='dark'] .btn.secondary:hover {
  background: #3f4d63;
}

/* Dark-theme popup rules used to live here as `[data-theme='dark']
   :deep(.foo)`, which doesn't work: :deep() always injects this
   component's scope attribute as a *required ancestor* of whatever it
   wraps (confirmed live), and there's no way to satisfy that when the
   selector needs to match under `[data-theme="dark"]` on <html> - <html>
   has no ancestors at all, scoped or not, so any :deep()-based version of
   this rule can never match anything. Moved to a genuinely global <style>
   block below instead (see its own doc comment). */

.filter-block {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
  width: 100%;
  padding-top: 10px;
  border-top: 1px solid #eee;
}

.filter-label {
  font-size: 13px;
  color: #667;
}

.filter-checkbox {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #445;
  cursor: pointer;
}

.dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.brand-filter-badge {
  margin-left: 6px;
  font-size: 11px;
  color: #1d4ed8;
}

/* Teleported to <body> (see the template) so it paints above Leaflet's own
   panes/controls regardless of DOM position - the same reason RegionForm/
   UserForm/ProxyForm use Teleport + a high z-index instead of an in-place
   absolutely-positioned popover. */
.brand-filter-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
}

.brand-filter-panel {
  position: fixed;
  width: 260px;
  max-width: calc(100vw - 32px);
  padding: 10px;
}

.brand-filter-actions {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
}

.brand-search {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid #ccd2d9;
  font-size: 13px;
}

.brand-filter-list {
  max-height: 220px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* Site dark theme (store/theme.js) - a second, smaller batch of this
   file's own colors (found on a follow-up sweep across the rest of the
   app) that tie in specificity with main.css's generic dark rules and can
   win on source order alone. */
[data-theme='dark'] .filter-block {
  border-top-color: #334155;
}

[data-theme='dark'] .filter-label,
[data-theme='dark'] .filter-checkbox {
  color: #94a3b8;
}

[data-theme='dark'] .brand-filter-badge {
  color: #93c5fd;
}

[data-theme='dark'] .brand-search {
  background: #1e293b;
  color: #e2e8f0;
  border-color: #334155;
}
</style>

<style>
/* Genuinely global (no `scoped` attribute), unlike every other <style>
   block in this app - needed specifically for these dark-theme popup
   rules. They must match under `[data-theme="dark"]` on <html>, which has
   no ancestors at all - scoped CSS (including :deep(), which still
   requires this component's own scope attribute as an ancestor somewhere
   in the selector - see the removed rules' own former doc comment in the
   scoped block above) can never satisfy that. Safe to be unscoped:
   confirmed these exact class names (.leaflet-popup-*, .popup-*) are only
   ever used by useMapMarkers.js's bindPopup calls - no other component
   renders anything using them, so there's nothing else on the site for an
   unscoped rule to accidentally style. */
[data-theme='dark'] .leaflet-popup-content-wrapper,
[data-theme='dark'] .leaflet-popup-tip {
  background: #1e293b;
  color: #e2e8f0;
}

[data-theme='dark'] .leaflet-container a.leaflet-popup-close-button {
  color: #94a3b8;
}

[data-theme='dark'] .popup-address,
[data-theme='dark'] .popup-hint,
[data-theme='dark'] .popup-sources {
  color: #94a3b8;
}

[data-theme='dark'] .popup-fuel-list {
  border-top-color: #334155;
}

[data-theme='dark'] .popup-source-chip {
  background: #334155;
  color: #e2e8f0;
}

[data-theme='dark'] .popup-sources-warn {
  color: #fcd34d;
}

[data-theme='dark'] .popup-ribbon-label {
  color: #94a3b8;
}

[data-theme='dark'] .popup-ribbon-bar {
  background: #334155;
}

[data-theme='dark'] .popup-ribbon-hint,
[data-theme='dark'] .popup-ribbon-empty {
  color: #64748b;
}
</style>
