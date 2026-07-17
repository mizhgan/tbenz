<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import L from 'leaflet';
import { regionsApi } from '../api/regions';
import { useMapBasemapStore, BASEMAP_STYLES, resolveBasemapUrl } from '../store/mapBasemap';
import { useThemeStore } from '../store/theme';
import ExportPanel from '../components/ExportPanel.vue';
import StationDetailModal from '../components/StationDetailModal.vue';
import MapShareCardModal from '../components/MapShareCardModal.vue';
import {
  statusMeta,
  fuelTypeLabel,
  sortFuelTypes,
  bestFuelStatus,
  CORE_FUEL_TYPES,
  MAYBE_AVAILABLE_WEIGHT,
} from '../utils/fuelStatus';
import { formatPct, availabilityColor } from '../utils/colorScale';
import { renderMapShareCard, MAP_CONTENT_WIDTH } from '../utils/mapShareCard';
import { canCopyImageToClipboard } from '../utils/stationCard';
import {
  canShareFile,
  captureMapBase,
  createGifEncoder,
  downsampleEvenly,
  lockMapInteraction,
  pickVideoMimeType,
  sleep,
} from '../utils/mapExport';

// leaflet-image (used for the export panel below) expects a global `L`, as
// most pre-ES-module Leaflet plugins do.
window.L = L;

const route = useRoute();
const basemapStore = useMapBasemapStore();
const themeStore = useThemeStore();

const STATUS_KEYS = ['available', 'maybe_available', 'not_available', 'no_data'];

const regions = ref([]);
const selectedRegionId = ref(route.query.region || '');
const range = ref({ from: null, to: null });
const atMs = ref(Date.now());
const stations = ref([]);
const selectedStation = ref(null);
const showDetailModal = ref(false);
const loadingStations = ref(false);
// True only until the very first regions+range+snapshot sequence finishes
// (see onMounted) - drives the one-time skeleton treatment for the controls
// bar (region select, filters, slider) so a slow connection shows an
// obviously-still-loading placeholder shaped like the real UI instead of an
// empty gap that then pops in all at once. loadingStations above keeps
// covering every *subsequent* snapshot fetch (slider drags, live refresh)
// with just the map's own spinner overlay.
const initialLoading = ref(true);
// Off-canvas filters/region/slider panel over the map (see .drawer-panel) -
// closed by default so the map itself is the first thing a visitor sees
// full-bleed, not a control bar. Auto-opens once on the very first load if
// there's no data yet (see the watcher below onMounted) so a first-time
// visitor whose region genuinely has nothing to show isn't left staring at
// an empty map with no visible way to find out why.
const drawerOpen = ref(false);
const errorMessage = ref('');
const liveMode = ref(true);
const hasFitted = ref(false);
// Hide "no data" stations by default - by far the most common noise on the map.
const statusFilters = reactive({
  available: true,
  maybe_available: true,
  not_available: true,
  no_data: false,
});

const UNKNOWN_BRAND = 'Без сети';
function brandOf(station) {
  return station.name || UNKNOWN_BRAND;
}

// Gasoline only, not diesel or gas conversions - deliberate, explicit call:
// gasoline is where this region's real shortage is (verified live: 92 at
// ~25%, 95 at ~29.5%, against diesel's own ~38.7% over the same stations/
// period - folding diesel in would have quietly diluted the number away
// from the fuel drivers are actually struggling to find). Imported from
// fuelStatus.js (shared with StationHistoryChart.vue/stationCard.js) rather
// than redefined here - drives the *default* filter selection below, not a
// server call, same list as the backend's metricsService.CORE_FUEL_TYPES.

// Defaults to gasoline checked, not empty - this is the actual filter (see
// the "Виды топлива" checkboxes in the drawer), not just a fallback: an
// unchecked filter that silently did nothing until touched would be a
// broken-feeling control. The user can still pick a different fuel type (or
// several) explicitly; unchecking everything falls back to this same
// default rather than reverting to "no filter, show blanket status" (see
// activeFuelTypes below) - there's deliberately no way back to a
// diesel/propane-diluted view from this UI anymore.
const selectedFuelTypes = ref([...CORE_FUEL_TYPES]);

const availableFuelTypes = computed(() => {
  const set = new Set();
  for (const s of stations.value) {
    for (const f of s.fuelStatuses || []) set.add(f.fuelType);
  }
  return sortFuelTypes(Array.from(set));
});

// The fuel type(s) actually driving both marker colors and the aggregate %
// right now - the user's explicit picks, or CORE_FUEL_TYPES if they've
// cleared every checkbox.
const activeFuelTypes = computed(() => (selectedFuelTypes.value.length ? selectedFuelTypes.value : CORE_FUEL_TYPES));

// A station's effective status is the best (see fuelStatus.js's
// bestFuelStatus) among activeFuelTypes - "is at least one of these
// available here" is the useful question for a single-color map dot, not
// "are all of them". Always fuel-type-scoped now (gasoline by default)
// rather than falling back to the station's blanket overall status - that
// blanket reading used to drive every dot on the map regardless of which
// specific fuel a driver needed.
function effectiveStatus(station) {
  return bestFuelStatus(station.fuelStatuses, activeFuelTypes.value);
}

// What the status-badge's percentage (and the marker colors) are actually
// about right now - shown next to the badge so it never reads as an
// unexplained number.
const badgeFuelLabel = computed(() => activeFuelTypes.value.map(fuelTypeLabel).join(', '));

// Current-state summary for the selected region - always over every loaded
// station, not just the ones visible under the status/brand checkboxes
// (those are for decluttering markers, not for changing what "the region's
// current state" actually is).
//
// Pools each station's own reading for activeFuelTypes, each counted as its
// own data point, rather than each station's one blanket overall status
// (what this used to do before fuel-type-scoping existed at all). A
// station's blanket status is usually driven by whichever fuel/source made
// it green, not necessarily the specific type a given driver needs - "52%
// of stations are open for business" and "27% chance your gasoline is
// actually there" are different, both potentially true, claims, and the
// second is the one a driver checking this badge is actually asking.
const currentSummary = computed(() => {
  // Pools each station's own reading for activeFuelTypes, each counted as
  // its own data point (see this function's own git history for why -
  // "52% of stations are open" and "27% chance your gasoline is actually
  // there" are different claims). Used only for availablePct below - with
  // 2 active fuel types by default, summing `counts` itself would come out
  // to ~2x the real station count, which is exactly the bug reported in
  // the Telegram digest cards (see telegramDigestData.js's own fix) and
  // turned out to affect this same live panel + the map share card too.
  const counts = { available: 0, maybe_available: 0, not_available: 0, no_data: 0 };
  const types = activeFuelTypes.value;
  for (const s of stations.value) {
    const byType = Object.fromEntries((s.fuelStatuses || []).map((f) => [f.fuelType, f.status]));
    for (const type of types) {
      const st = byType[type] || 'no_data';
      counts[st] = (counts[st] || 0) + 1;
    }
  }
  const known = counts.available + counts.maybe_available + counts.not_available;
  // Same MAYBE_AVAILABLE_WEIGHT every other single-number "доступность"
  // figure in the app now uses (reports ranking, heatmap, Telegram
  // digest/alerts - see metricsService.js's own doc comment) - this badge
  // used to give maybe_available full credit, same as available.
  const availablePct =
    known > 0 ? ((counts.available + MAYBE_AVAILABLE_WEIGHT * counts.maybe_available) / known) * 100 : null;

  // One status per station (bestFuelStatus, same as the marker dots and
  // StationDetailModal's own badge) - sums to exactly stations.value.length,
  // unlike `counts` above. What the live panel's four numbers and the
  // share card's stat tiles actually display.
  const stationCounts = { available: 0, maybe_available: 0, not_available: 0, no_data: 0 };
  for (const s of stations.value) {
    const st = bestFuelStatus(s.fuelStatuses, types);
    stationCounts[st] = (stationCounts[st] || 0) + 1;
  }

  return { counts, stationCounts, availablePct, total: stations.value.length };
});

const selectedRegion = computed(() => regions.value.find((r) => r._id === selectedRegionId.value) || null);

// Keyed by brand name -> visible. Populated lazily as brands show up in
// loaded snapshots (see ensureBrandFilterKeys) rather than rebuilt from
// scratch each time, so a user's unchecked brands stay unchecked as the
// time slider moves or live refresh brings in a new snapshot.
const brandFilters = reactive({});
const brandSearch = ref('');

const availableBrands = computed(() =>
  Array.from(new Set(stations.value.map(brandOf))).sort((a, b) => a.localeCompare(b, 'ru'))
);

const visibleBrandOptions = computed(() => {
  const query = brandSearch.value.trim().toLowerCase();
  if (!query) return availableBrands.value;
  return availableBrands.value.filter((b) => b.toLowerCase().includes(query));
});

function ensureBrandFilterKeys() {
  for (const brand of availableBrands.value) {
    if (!(brand in brandFilters)) brandFilters[brand] = true;
  }
}

function setAllBrands(visible) {
  for (const brand of availableBrands.value) {
    brandFilters[brand] = visible;
  }
  renderMarkers();
}

// The status checkboxes already sit next to the toggle (see .quick-status-
// filters) and stay visible with the drawer closed - but fuel-type and
// brand filters only live inside the drawer, so closing it after picking
// either used to leave no sign anything was filtered at all. This drives a
// small badge next to the toggle for exactly those two (see the template).
//
// Compares against CORE_FUEL_TYPES (the default selection, gasoline), not
// against "empty" - selectedFuelTypes now starts non-empty (see its own
// comment above), so a bare length check would have shown this badge
// permanently from the very first load, even though nothing was actually
// changed from the default.
function sameFuelTypeSet(a, b) {
  return a.length === b.length && new Set(b).size === new Set([...a, ...b]).size;
}

const hasActiveExtraFilters = computed(
  () =>
    !sameFuelTypeSet(selectedFuelTypes.value, CORE_FUEL_TYPES) ||
    Object.values(brandFilters).some((visible) => visible === false)
);

function resetExtraFilters() {
  selectedFuelTypes.value = [...CORE_FUEL_TYPES];
  setAllBrands(true);
}

// The dropdown panel is teleported to <body> and positioned by fixed
// coordinates rather than living inline inside the controls card. Leaflet's
// own panes/markers use fairly high z-indexes within their own stacking
// context, and an ordinary in-place `position: absolute` popover here ended
// up rendered behind the map instead of above it - the same class of issue
// already worked around for RegionForm/UserForm/ProxyForm via Teleport.
const brandButtonRef = ref(null);
const brandPanelRef = ref(null);
const brandPanelOpen = ref(false);
const brandPanelPos = reactive({ top: 0, left: 0 });

const BRAND_PANEL_WIDTH = 260;

function updateBrandPanelPos() {
  if (!brandButtonRef.value) return;
  const rect = brandButtonRef.value.getBoundingClientRect();
  brandPanelPos.top = rect.bottom + 6;
  // Clamp so the panel stays fully on-screen even when the toggle button
  // sits near the right edge of a narrow (phone-width) viewport.
  const maxLeft = window.innerWidth - BRAND_PANEL_WIDTH - 16;
  brandPanelPos.left = Math.max(16, Math.min(rect.left, maxLeft));
}

function toggleBrandPanel() {
  if (brandPanelOpen.value) {
    brandPanelOpen.value = false;
    return;
  }
  updateBrandPanelPos();
  brandPanelOpen.value = true;
}

function closeBrandPanel() {
  brandPanelOpen.value = false;
}

// Scroll events don't bubble, but a capturing listener on window still sees
// them - including scrolling the panel's own internal checkbox list, which
// should NOT close the panel. Only close for scrolls happening outside it.
function handleWindowScroll(event) {
  if (brandPanelRef.value && brandPanelRef.value.contains(event.target)) return;
  closeBrandPanel();
}

const showExportPanel = ref(false);
const exportGenerating = ref(false);
const exportFetchProgress = ref(0);
const exportEncodeProgress = ref(0);
const exportResultUrl = ref(null);
const exportResultMimeType = ref('');
const exportError = ref('');
const exportCanShare = ref(false);
const exportFrameInfo = ref('');
const videoExportSupported = ref(!!pickVideoMimeType());
let exportResultFile = null;

// Shareable "map snapshot" card - a single still image (map + markers +
// currentSummary's stat tiles) rather than the animation export above,
// which needs a from/to range and produces a GIF/video. Same
// generate -> preview -> copy/download/share UI pattern as the station and
// region report cards (StationDetailModal.vue/ReportsView.vue).
const showShareCard = ref(false);
const shareCardGenerating = ref(false);
const shareCardUrl = ref(null);
const shareCardError = ref('');
const shareCardCopyFeedback = ref('');
const shareCardCanShare = ref(false);
const shareCardClipboardSupported = canCopyImageToClipboard();
let shareCardBlob = null;
let shareCardFile = null;

const mapContainer = ref(null);
let map = null;
let markersLayer = null;
let tileLayer = null;
// Drives .leaflet-map--dark-filter (see this file's own <style>) - "Обычная"
// (OSM's own tiles) has no dark-native variant to switch to the way
// "Контрастная" swaps to Carto's dark_all, so dark site theme + this style
// needs a CSS approximation instead (see applyBasemapStyle's own comment
// on the exact filter values). Light theme needs no filter at all here -
// "Обычная" is meant to be genuinely standard, unmodified OSM in that case.
const useDarkTileFilter = ref(false);
let liveTimer = null;
let sliderDebounceTimer = null;
let snapshotRequestId = 0;
let resizeObserver = null;

const hasRange = computed(() => range.value.from !== null && range.value.to !== null);
const atLabel = computed(() => formatDateTime(atMs.value));
const filteredStations = computed(() =>
  stations.value.filter(
    (s) => statusFilters[effectiveStatus(s)] !== false && brandFilters[brandOf(s)] !== false
  )
);

function formatDateTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('ru-RU');
}

async function loadRegions() {
  regions.value = await regionsApi.list();
  if (!selectedRegionId.value && regions.value.length) {
    selectedRegionId.value = regions.value[0]._id;
  }
}

async function loadRange() {
  if (!selectedRegionId.value) return;
  const r = await regionsApi.historyRange(selectedRegionId.value);
  if (!r.from || !r.to) {
    range.value = { from: null, to: null };
    stations.value = [];
    return;
  }
  const now = Date.now();
  const toMs = Math.max(new Date(r.to).getTime(), now);
  range.value = { from: new Date(r.from).getTime(), to: toMs };
  atMs.value = range.value.to;
}

async function loadSnapshot() {
  if (!selectedRegionId.value || !hasRange.value) return;
  const requestId = ++snapshotRequestId;
  loadingStations.value = true;
  errorMessage.value = '';
  try {
    const at = new Date(atMs.value).toISOString();
    const data = await regionsApi.snapshotAt(selectedRegionId.value, at);
    if (requestId !== snapshotRequestId) return; // a newer request has since started
    stations.value = data.stations;
    ensureBrandFilterKeys();
    renderMarkers();
  } catch (err) {
    if (requestId !== snapshotRequestId) return;
    errorMessage.value = 'Не удалось загрузить данные станций';
  } finally {
    if (requestId === snapshotRequestId) loadingStations.value = false;
  }
}

// Station name/address/fuel-type strings ultimately come from the scraped
// upstream source, not from anything this app controls - they're injected
// into marker tooltips/popups as raw HTML (Leaflet sets tooltip/popup
// content via innerHTML), so they need escaping like any other untrusted
// string headed into innerHTML, not just user-typed input.
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

// Popup content replaces the old always-visible sidebar: a compact summary
// right on the marker, with a button into the same full StationDetailModal
// as before. Built as an HTML string (Leaflet's own content model) rather
// than a Vue component, since Leaflet popups aren't part of Vue's render
// tree - the "Подробная информация" button below is wired up to Vue state
// via the popupopen handler in renderMarkers(), not a @click binding.
function buildPopupHtml(s) {
  const meta = statusMeta(effectiveStatus(s));
  const fuelSuffix = ` (${escapeHtml(badgeFuelLabel.value)})`;
  const fuelRows = (s.fuelStatuses || [])
    .map((f) => {
      const fm = statusMeta(f.status);
      return `<div class="popup-fuel-row"><span class="popup-dot" style="background:${fm.color}"></span>${escapeHtml(fuelTypeLabel(f.fuelType))}: ${fm.label}</div>`;
    })
    .join('');
  // overallLastTransactionAt (freshest across tbank + every matched
  // secondary source - see Station.js's own doc comment), not tbank's own
  // lastTransactionAt alone - a station last confirmed via tbank a week ago
  // but seen by sberazs 6 hours ago should read "6 hours ago" here, not the
  // week-old tbank-only date.
  const lastTransactionLabel = s.overallLastTransactionAt
    ? formatDateTime(new Date(s.overallLastTransactionAt).getTime())
    : 'нет данных';
  return `
    <div class="station-popup">
      <div class="popup-title">${escapeHtml(s.name || 'АЗС')}</div>
      ${s.address ? `<div class="popup-address">${escapeHtml(s.address)}</div>` : ''}
      <div class="popup-status"><span class="popup-dot" style="background:${meta.color}"></span>${meta.label}${fuelSuffix}</div>
      ${fuelRows ? `<div class="popup-fuel-list">${fuelRows}</div>` : ''}
      ${sourcesSummaryHtml(s)}
      <div class="popup-hint">Последняя транзакция: ${escapeHtml(lastTransactionLabel)}</div>
      <button type="button" class="btn secondary popup-detail-btn">Подробная информация</button>
    </div>
  `;
}

// One-line "how many sources agree" summary, cheap enough to show on every
// marker popup since regionsApi.snapshotAt() already carries tbankStatus and
// a generic sources[] array for each station (see metricsService's
// getCurrentSnapshot, one entry per registered secondary source this
// station is actually matched to - see backend/src/services/
// sourceRegistry.js) - the fuller per-source breakdown (fuel types, address,
// conflict) only loads once "Подробная информация" is opened, inside
// StationDetailModal itself.
//
// Chips still show each source's own blanket overall status (their literal
// claim, for transparency) - but the "⚠ расходятся" warning compares each
// source's coreStatus (best-of among 92/95 gasoline, see backend's
// metricsService.deriveCoreStatus) against tbank's own tbankCoreStatus
// instead of blanket vs blanket - a source disagreeing purely over diesel/
// propane/98/100 isn't a claim this warning is about.
function sourcesSummaryHtml(s) {
  const sources = s.sources || [];
  if (!sources.length) {
    return `<div class="popup-sources">Источник: только tbank</div>`;
  }
  const tbankMeta = statusMeta(s.tbankStatus);
  const chips = [
    `<span class="popup-source-chip"><span class="popup-dot" style="background:${tbankMeta.color}"></span>tbank</span>`,
  ];
  let disagree = false;
  for (const source of sources) {
    const meta = statusMeta(source.status);
    chips.push(
      `<span class="popup-source-chip"><span class="popup-dot" style="background:${meta.color}"></span>${escapeHtml(source.key)}</span>`
    );
    if (source.coreStatus !== s.tbankCoreStatus) disagree = true;
  }
  return `
    <div class="popup-sources">
      ${chips.join('')}
      ${disagree ? '<span class="popup-sources-warn">⚠ расходятся (АИ-92, АИ-95)</span>' : ''}
    </div>
  `;
}

// Fixed screen-pixel radius (unchanged below zoom 14) means markers stay
// the same visual size while the base tiles reveal more and more colored
// detail (building fills, industrial-zone polygons, parking icons) as you
// zoom in - confirmed live: at street level a plain 7px dot gets lost
// against OSM's own busy styling. Growing the radius past zoom 14 keeps
// markers' visual weight roughly in step with that increasing density,
// capped so they don't turn into oversized blobs at max zoom.
const MARKER_BASE_RADIUS = 7;
const MARKER_GROW_FROM_ZOOM = 14;
const MARKER_MAX_RADIUS = 10;
function markerRadiusForZoom(zoom) {
  if (zoom <= MARKER_GROW_FROM_ZOOM) return MARKER_BASE_RADIUS;
  return Math.min(MARKER_MAX_RADIUS, MARKER_BASE_RADIUS + (zoom - MARKER_GROW_FROM_ZOOM));
}

// Re-sizes markers in place on zoom change rather than calling
// renderMarkers() again - that clears and rebuilds the whole layer, which
// would close any popup the user has open mid-zoom for no reason.
function updateMarkerRadii() {
  if (!map || !markersLayer) return;
  const radius = markerRadiusForZoom(map.getZoom());
  markersLayer.eachLayer((marker) => marker.setRadius(radius));
}

// Swaps the whole tile provider - the header switcher
// (App.vue/store/mapBasemap.js) picks between plain OSM and Carto, which
// needs a different URL/attribution entirely, not just a style tweak on
// the same tiles. Re-run whenever *either* the basemap style or the site
// theme changes (see the two watchers in onMounted) - "contrast" resolves
// to a different Carto variant per theme (resolveBasemapUrl), so a theme
// flip needs to swap tiles even if the style itself didn't change.
function applyBasemapStyle() {
  if (!map) return;
  const styleKey = basemapStore.style;
  const cfg = BASEMAP_STYLES[styleKey] || BASEMAP_STYLES.standard;
  if (tileLayer) tileLayer.remove();
  tileLayer = L.tileLayer(resolveBasemapUrl(styleKey, themeStore.theme), {
    attribution: cfg.attribution,
    subdomains: cfg.subdomains,
    maxZoom: 19,
    crossOrigin: true,
  }).addTo(map);
  // "Контрастная" needs no filter regardless of theme (it already swapped
  // to the matching Carto variant above) - only "Обычная" in dark theme
  // does, see .leaflet-map--dark-filter's own doc comment for why.
  useDarkTileFilter.value = styleKey === 'standard' && themeStore.theme === 'dark';
}

function renderMarkers() {
  if (!map) return;
  markersLayer.clearLayers();
  const radius = markerRadiusForZoom(map.getZoom());
  for (const s of filteredStations.value) {
    const meta = statusMeta(effectiveStatus(s));
    const marker = L.circleMarker([s.lat, s.lon], {
      radius,
      // White outline independent of the status color (previously `color`
      // matched `fillColor`, so the "stroke" was invisible as a stroke) -
      // guarantees separation from whatever's directly underneath, since a
      // same-color-as-fill edge blends into equally-colored map features
      // (a red marker over a red/orange road, a green one over a park).
      color: '#fff',
      fillColor: meta.color,
      fillOpacity: 0.85,
      weight: 2,
    });
    const fuelSuffix = ` (${escapeHtml(badgeFuelLabel.value)})`;
    marker.bindTooltip(`${escapeHtml(s.name || 'АЗС')} — ${meta.label}${fuelSuffix}`);
    marker.bindPopup(() => buildPopupHtml(s), { maxWidth: 260, minWidth: 220 });
    // The button inside the popup isn't part of Vue's render tree (it's raw
    // HTML Leaflet drops into the DOM), so it can't use @click - wire it up
    // imperatively each time this marker's popup actually opens instead.
    marker.on('popupopen', (e) => {
      selectedStation.value = s;
      const el = e.popup.getElement();
      const btn = el ? el.querySelector('.popup-detail-btn') : null;
      if (btn) {
        btn.addEventListener('click', openDetailModal);
      }
    });
    markersLayer.addLayer(marker);
  }
  if (stations.value.length && !hasFitted.value) {
    const bounds = L.latLngBounds(stations.value.map((s) => [s.lat, s.lon]));
    map.fitBounds(bounds, { padding: [30, 30] });
    hasFitted.value = true;
  }
}

function handleFilterChange() {
  renderMarkers();
}

function openDetailModal() {
  showDetailModal.value = true;
}

function closeDetailModal() {
  showDetailModal.value = false;
}

async function handleRegionChange() {
  selectedStation.value = null;
  showDetailModal.value = false;
  hasFitted.value = false;
  // Brand names from the previous region don't apply here - drop them so
  // the checklist starts fresh (all visible) instead of carrying over an
  // unrelated, stale selection.
  for (const key of Object.keys(brandFilters)) delete brandFilters[key];
  brandSearch.value = '';
  selectedFuelTypes.value = [...CORE_FUEL_TYPES];
  await loadRange();
  await loadSnapshot();
}

function handleSliderInput() {
  liveMode.value = atMs.value >= range.value.to;
  clearTimeout(sliderDebounceTimer);
  sliderDebounceTimer = setTimeout(loadSnapshot, 120);
}

async function handleSliderChange() {
  clearTimeout(sliderDebounceTimer);
  liveMode.value = atMs.value >= range.value.to;
  await loadSnapshot();
}

async function jumpToNow() {
  liveMode.value = true;
  await loadRange();
  await loadSnapshot();
}

function openExportPanel() {
  if (!hasRange.value) return;
  exportError.value = '';
  showExportPanel.value = true;
}

function resetExportResult() {
  if (exportResultUrl.value) {
    URL.revokeObjectURL(exportResultUrl.value);
    exportResultUrl.value = null;
  }
  exportResultMimeType.value = '';
  exportResultFile = null;
  exportCanShare.value = false;
  exportFrameInfo.value = '';
  exportError.value = '';
}

function closeExportPanel() {
  showExportPanel.value = false;
  resetExportResult();
}

async function handleShareExport() {
  if (!exportResultFile) return;
  try {
    await navigator.share({
      files: [exportResultFile],
      title: 'Статусы доступности топлива',
    });
  } catch (err) {
    if (err.name !== 'AbortError') {
      exportError.value = `Не удалось поделиться: ${err.message || 'неизвестная ошибка'}`;
    }
  }
}

async function handleGenerateExport({ fromMs, toMs, maxFrames, frameDelayMs, format }) {
  if (!map || !selectedRegionId.value) return;

  resetExportResult();
  exportGenerating.value = true;
  exportFetchProgress.value = 0;
  exportEncodeProgress.value = 0;

  const unlock = lockMapInteraction(map);
  try {
    const { times } = await regionsApi.snapshotTimes(selectedRegionId.value, {
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
    });
    if (!times.length) {
      throw new Error('В выбранном диапазоне нет сохранённых снимков');
    }
    const allTimestamps = times.map((t) => new Date(t).getTime()).sort((a, b) => a - b);
    const timestamps = downsampleEvenly(allTimestamps, maxFrames);
    exportFrameInfo.value =
      timestamps.length < allTimestamps.length
        ? `Найдено снимков: ${allTimestamps.length}, использовано (равномерно прорежено): ${timestamps.length}`
        : `Использовано снимков: ${timestamps.length}`;

    const size = map.getSize();

    markersLayer.remove();
    let baseCanvas;
    try {
      baseCanvas = await captureMapBase(map);
    } finally {
      markersLayer.addTo(map);
    }

    const frameCanvas = document.createElement('canvas');
    frameCanvas.width = size.x;
    frameCanvas.height = size.y;
    const ctx = frameCanvas.getContext('2d');

    // Fetches one moment's station snapshot and paints it (dots + timestamp
    // label) over the frozen base map image already on `ctx`.
    async function drawFrame(ts) {
      const data = await regionsApi.snapshotAt(selectedRegionId.value, new Date(ts).toISOString());
      const frameStations = data.stations.filter(
        (s) => statusFilters[effectiveStatus(s)] !== false && brandFilters[brandOf(s)] !== false
      );

      ctx.drawImage(baseCanvas, 0, 0, size.x, size.y);
      for (const s of frameStations) {
        const pt = map.latLngToContainerPoint([s.lat, s.lon]);
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = statusMeta(effectiveStatus(s)).color;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      }

      const label = formatDateTime(ts);
      ctx.font = '13px sans-serif';
      const textWidth = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
      ctx.fillRect(8, 8, textWidth + 16, 24);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, 16, 25);
    }

    let blob;
    let mimeType;

    if (format === 'video') {
      mimeType = pickVideoMimeType();
      if (!mimeType) throw new Error('Браузер не поддерживает запись видео');

      const stream = frameCanvas.captureStream(0);
      const track = stream.getVideoTracks()[0];
      const recorder = new MediaRecorder(stream, { mimeType });
      const chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      const stopped = new Promise((resolve) => {
        recorder.onstop = resolve;
      });

      recorder.start();
      for (let i = 0; i < timestamps.length; i++) {
        await drawFrame(timestamps[i]);
        track.requestFrame();
        const progress = Math.round(((i + 1) / timestamps.length) * 100);
        exportFetchProgress.value = progress;
        exportEncodeProgress.value = progress;
        await sleep(frameDelayMs);
      }
      recorder.stop();
      await stopped;
      blob = new Blob(chunks, { type: mimeType });
    } else {
      mimeType = 'image/gif';
      const encoder = createGifEncoder({ width: size.x, height: size.y });
      encoder.on('progress', (ratio) => {
        exportEncodeProgress.value = Math.round(ratio * 100);
      });

      for (let i = 0; i < timestamps.length; i++) {
        await drawFrame(timestamps[i]);
        encoder.addFrame(ctx, { copy: true, delay: frameDelayMs });
        exportFetchProgress.value = Math.round(((i + 1) / timestamps.length) * 100);
      }

      blob = await new Promise((resolve, reject) => {
        encoder.on('finished', resolve);
        encoder.on('abort', () => reject(new Error('Генерация прервана')));
        encoder.render();
      });
    }

    exportResultUrl.value = URL.createObjectURL(blob);
    exportResultMimeType.value = mimeType;
    const extension = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('webm') ? 'webm' : 'gif';
    exportResultFile = new File([blob], `fuel-status.${extension}`, { type: mimeType });
    exportCanShare.value = canShareFile(exportResultFile);
  } catch (err) {
    exportError.value = `Не удалось создать экспорт: ${err.message || 'неизвестная ошибка'}`;
  } finally {
    exportGenerating.value = false;
    unlock();
  }
}

function resetShareCard() {
  if (shareCardUrl.value) {
    URL.revokeObjectURL(shareCardUrl.value);
    shareCardUrl.value = null;
  }
  shareCardBlob = null;
  shareCardFile = null;
  shareCardCanShare.value = false;
  shareCardCopyFeedback.value = '';
  shareCardError.value = '';
}

// Captures the map exactly as currently shown (same base-tile capture the
// animation export uses, plus the same status/brand-filtered markers
// actually on screen right now - not the unfiltered currentSummary set,
// so the picture matches what the user was just looking at) and composes
// it with currentSummary's stat tiles into one shareable image.
async function generateShareCard() {
  if (!map) return;
  resetShareCard();
  shareCardGenerating.value = true;

  const unlock = lockMapInteraction(map);
  try {
    const size = map.getSize();
    markersLayer.remove();
    let baseCanvas;
    try {
      baseCanvas = await captureMapBase(map);
    } finally {
      markersLayer.addTo(map);
    }

    const frameCanvas = document.createElement('canvas');
    frameCanvas.width = size.x;
    frameCanvas.height = size.y;
    const ctx = frameCanvas.getContext('2d');
    ctx.drawImage(baseCanvas, 0, 0, size.x, size.y);

    // The share card scales this whole canvas down to a fixed content width
    // (see mapShareCard.js) - on a wide desktop window that shrinks a
    // fixed on-screen dot radius into an indistinct smear wherever
    // stations cluster (e.g. a city center). Inflating the radius here by
    // the inverse of that eventual scale keeps the *final* dot size
    // consistent (~8px radius) regardless of how wide the map happened to
    // be captured at.
    const shareCardScale = MAP_CONTENT_WIDTH / size.x;
    const dotRadius = 8 / shareCardScale;
    const dotStroke = 2 / shareCardScale;

    const visibleStations = stations.value.filter(
      (s) => statusFilters[effectiveStatus(s)] !== false && brandFilters[brandOf(s)] !== false
    );
    for (const s of visibleStations) {
      const pt = map.latLngToContainerPoint([s.lat, s.lon]);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, dotRadius, 0, Math.PI * 2);
      ctx.fillStyle = statusMeta(effectiveStatus(s)).color;
      ctx.fill();
      ctx.lineWidth = dotStroke;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }

    const blob = await renderMapShareCard({
      regionName: selectedRegion.value?.name || 'Район',
      mapCanvas: frameCanvas,
      counts: currentSummary.value.stationCounts,
      stationCount: currentSummary.value.total,
      availablePct: currentSummary.value.availablePct,
      fuelLabel: badgeFuelLabel.value,
      generatedAt: Date.now(),
    });
    shareCardBlob = blob;
    shareCardUrl.value = URL.createObjectURL(blob);
    const safeName = (selectedRegion.value?.name || 'map').replace(/[^\p{L}\p{N}]+/gu, '-');
    shareCardFile = new File([blob], `${safeName}-map.png`, { type: 'image/png' });
    shareCardCanShare.value = canShareFile(shareCardFile);
  } catch (err) {
    shareCardError.value = `Не удалось создать картинку: ${err.message || 'неизвестная ошибка'}`;
  } finally {
    shareCardGenerating.value = false;
    unlock();
  }
}

function openShareCard() {
  showShareCard.value = true;
  generateShareCard();
}

function closeShareCard() {
  showShareCard.value = false;
  resetShareCard();
}

async function copyShareCardToClipboard() {
  if (!shareCardBlob) return;
  shareCardCopyFeedback.value = '';
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': shareCardBlob })]);
    shareCardCopyFeedback.value = 'ok';
  } catch (err) {
    shareCardCopyFeedback.value = 'error';
    shareCardError.value = `Не удалось скопировать: ${err.message || 'неизвестная ошибка'}`;
  }
}

async function shareShareCard() {
  if (!shareCardFile) return;
  try {
    await navigator.share({ files: [shareCardFile], title: 'Карта доступности топлива' });
  } catch (err) {
    if (err.name !== 'AbortError') {
      shareCardError.value = `Не удалось поделиться: ${err.message || 'неизвестная ошибка'}`;
    }
  }
}

onMounted(async () => {
  // zoomControl: false + added back at bottomright - Leaflet's default
  // topleft position would sit right under the new drawer-toggle button
  // (see .drawer-toggle/.status-badge in the template), which also lives in
  // that corner now that the old control bar no longer pushes the map down.
  map = L.map(mapContainer.value, { zoomControl: false }).setView([55.75, 37.62], 6);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  // Leaflet's own "Leaflet" link in the attribution control is just its
  // default branding, not a license requirement - drop it. The OpenStreetMap
  // attribution added by the tile layer below stays: it's required by OSM's
  // tile usage policy for their free tiles, unlike the Leaflet prefix.
  map.attributionControl.setPrefix(false);
  applyBasemapStyle();
  // Live-reacts to the header switchers (App.vue) even while already
  // looking at the map - registered here (not at module scope) so they can
  // safely assume `map` already exists; watch() only fires on *future*
  // changes (no `immediate`), so there's no risk of running before that.
  watch(() => basemapStore.style, applyBasemapStyle);
  watch(() => themeStore.theme, applyBasemapStyle);
  markersLayer = L.layerGroup().addTo(map);
  map.on('zoomend', updateMarkerRadii);

  // The map's container is stretched by flex layout to match the sidebar's
  // height (see .map-body), which grows when a station is selected (more
  // details, forecast, history chart). Leaflet has no way to know its
  // container was resized by something other than itself, so without this
  // it keeps clipping tiles/markers to whatever size it was at
  // construction time - invalidateSize() tells it to re-measure.
  resizeObserver = new ResizeObserver(() => {
    map.invalidateSize();
  });
  resizeObserver.observe(mapContainer.value);

  // Close the teleported brand dropdown rather than let it drift out of
  // place if the page scrolls or the window resizes while it's open.
  window.addEventListener('scroll', handleWindowScroll, true);
  window.addEventListener('resize', closeBrandPanel);

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

  liveTimer = setInterval(async () => {
    if (!liveMode.value || !selectedRegionId.value) return;
    await loadRange();
    await loadSnapshot();
  }, 20000);
});

onBeforeUnmount(() => {
  window.removeEventListener('scroll', handleWindowScroll, true);
  window.removeEventListener('resize', closeBrandPanel);
  clearInterval(liveTimer);
  clearTimeout(sliderDebounceTimer);
  if (resizeObserver) resizeObserver.disconnect();
  if (exportResultUrl.value) URL.revokeObjectURL(exportResultUrl.value);
  if (map) map.remove();
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
            <input type="checkbox" v-model="statusFilters[key]" @change="handleFilterChange" />
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
                    <input type="checkbox" v-model="selectedFuelTypes" :value="ft" @change="handleFilterChange" />
                    {{ fuelTypeLabel(ft) }}
                  </label>
                </template>

                <span class="filter-label">Показывать:</span>
                <label v-for="key in STATUS_KEYS" :key="key" class="filter-checkbox">
                  <input type="checkbox" v-model="statusFilters[key]" @change="handleFilterChange" />
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
              <input type="checkbox" v-model="brandFilters[brand]" @change="handleFilterChange" />
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

[data-theme='dark'] :deep(.leaflet-popup-content-wrapper),
[data-theme='dark'] :deep(.leaflet-popup-tip) {
  background: #1e293b;
  color: #e2e8f0;
}

[data-theme='dark'] :deep(.leaflet-container a.leaflet-popup-close-button) {
  color: #94a3b8;
}

[data-theme='dark'] :deep(.popup-address),
[data-theme='dark'] :deep(.popup-hint),
[data-theme='dark'] :deep(.popup-sources) {
  color: #94a3b8;
}

[data-theme='dark'] :deep(.popup-fuel-list) {
  border-top-color: #334155;
}

[data-theme='dark'] :deep(.popup-source-chip) {
  background: #334155;
  color: #e2e8f0;
}

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

[data-theme='dark'] :deep(.popup-sources-warn) {
  color: #fcd34d;
}
</style>
