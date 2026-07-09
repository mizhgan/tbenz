<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import L from 'leaflet';
import { regionsApi } from '../api/regions';
import ExportPanel from '../components/ExportPanel.vue';
import StationDetailModal from '../components/StationDetailModal.vue';
import { statusMeta, fuelTypeLabel, sortFuelTypes } from '../utils/fuelStatus';
import { formatPct } from '../utils/colorScale';
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

const STATUS_KEYS = ['available', 'maybe_available', 'not_available', 'no_data'];

const regions = ref([]);
const selectedRegionId = ref(route.query.region || '');
const range = ref({ from: null, to: null });
const atMs = ref(Date.now());
const stations = ref([]);
const selectedStation = ref(null);
const showDetailModal = ref(false);
const loadingStations = ref(false);
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

// '' means "any fuel type" - filter/color markers by the station's overall
// status. Otherwise, both the checkboxes above and marker colors switch to
// that specific fuel type's status instead of the aggregate one.
const selectedFuelType = ref('');

const availableFuelTypes = computed(() => {
  const set = new Set();
  for (const s of stations.value) {
    for (const f of s.fuelStatuses || []) set.add(f.fuelType);
  }
  return sortFuelTypes(Array.from(set));
});

function effectiveStatus(station) {
  if (!selectedFuelType.value) return station.status;
  const entry = (station.fuelStatuses || []).find((f) => f.fuelType === selectedFuelType.value);
  return entry ? entry.status : 'no_data';
}

// Current-state summary for the selected region - always over every loaded
// station, not just the ones visible under the status/brand checkboxes
// (those are for decluttering markers, not for changing what "the region's
// current state" actually is). Uses the same effectiveStatus() the markers
// are colored by, so this never disagrees with what's drawn on the map,
// including when a specific fuel type is selected instead of overall status.
const currentSummary = computed(() => {
  const counts = { available: 0, maybe_available: 0, not_available: 0, no_data: 0 };
  for (const s of stations.value) {
    const st = effectiveStatus(s);
    counts[st] = (counts[st] || 0) + 1;
  }
  const known = counts.available + counts.maybe_available + counts.not_available;
  const availablePct = known > 0 ? ((counts.available + counts.maybe_available) / known) * 100 : null;
  return { counts, availablePct, total: stations.value.length };
});

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

const mapContainer = ref(null);
let map = null;
let markersLayer = null;
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
  const fuelSuffix = selectedFuelType.value ? ` (${escapeHtml(fuelTypeLabel(selectedFuelType.value))})` : '';
  const fuelRows = (s.fuelStatuses || [])
    .map((f) => {
      const fm = statusMeta(f.status);
      return `<div class="popup-fuel-row"><span class="popup-dot" style="background:${fm.color}"></span>${escapeHtml(fuelTypeLabel(f.fuelType))}: ${fm.label}</div>`;
    })
    .join('');
  const lastTransactionLabel = s.lastTransactionAt
    ? formatDateTime(new Date(s.lastTransactionAt).getTime())
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
    if (source.status !== s.tbankStatus) disagree = true;
  }
  return `
    <div class="popup-sources">
      ${chips.join('')}
      ${disagree ? '<span class="popup-sources-warn">⚠ расходятся</span>' : ''}
    </div>
  `;
}

function renderMarkers() {
  if (!map) return;
  markersLayer.clearLayers();
  for (const s of filteredStations.value) {
    const meta = statusMeta(effectiveStatus(s));
    const marker = L.circleMarker([s.lat, s.lon], {
      radius: 7,
      color: meta.color,
      fillColor: meta.color,
      fillOpacity: 0.85,
      weight: 2,
    });
    const fuelSuffix = selectedFuelType.value ? ` (${escapeHtml(fuelTypeLabel(selectedFuelType.value))})` : '';
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
  selectedFuelType.value = '';
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

onMounted(async () => {
  map = L.map(mapContainer.value).setView([55.75, 37.62], 6);
  // Leaflet's own "Leaflet" link in the attribution control is just its
  // default branding, not a license requirement - drop it. The OpenStreetMap
  // attribution added by the tile layer below stays: it's required by OSM's
  // tile usage policy for their free tiles, unlike the Leaflet prefix.
  map.attributionControl.setPrefix(false);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
    crossOrigin: true,
  }).addTo(map);
  markersLayer = L.layerGroup().addTo(map);

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

  await loadRegions();
  if (selectedRegionId.value) {
    await loadRange();
    await loadSnapshot();
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
    <div class="controls card">
      <div class="form-row region-select">
        <label>Район</label>
        <select v-model="selectedRegionId" @change="handleRegionChange">
          <option v-for="r in regions" :key="r._id" :value="r._id">{{ r.name }}</option>
        </select>
      </div>

      <template v-if="hasRange">
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
      </template>
      <p v-else class="hint">
        Для этого района ещё нет исторических данных. Опросите его на странице «Районы».
      </p>

      <div v-if="hasRange" class="filter-block">
        <select
          v-if="availableFuelTypes.length"
          v-model="selectedFuelType"
          class="fuel-type-select"
          @change="handleFilterChange"
        >
          <option value="">Общий статус (все виды топлива)</option>
          <option v-for="ft in availableFuelTypes" :key="ft" :value="ft">{{ fuelTypeLabel(ft) }}</option>
        </select>

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

      <div v-if="currentSummary.total" class="current-state-inline">
        <span class="current-state-label">
          Сейчас{{ selectedFuelType ? ` · ${fuelTypeLabel(selectedFuelType)}` : '' }}:
        </span>
        <strong class="current-state-pct" :style="{ color: statusMeta('available').color }">
          {{ formatPct(currentSummary.availablePct) }}
        </strong>
        <span class="current-state-item">
          <span class="dot" :style="{ background: statusMeta('available').color }"></span>
          {{ currentSummary.counts.available }}
        </span>
        <span class="current-state-item">
          <span class="dot" :style="{ background: statusMeta('maybe_available').color }"></span>
          {{ currentSummary.counts.maybe_available }}
        </span>
        <span class="current-state-item">
          <span class="dot" :style="{ background: statusMeta('not_available').color }"></span>
          {{ currentSummary.counts.not_available }}
        </span>
        <span class="current-state-item">
          <span class="dot" :style="{ background: statusMeta('no_data').color }"></span>
          {{ currentSummary.counts.no_data }}
        </span>
        <span class="current-state-shown hint small">
          показано {{ filteredStations.length }} из {{ stations.length }}
        </span>
      </div>
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

    <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>

    <div ref="mapContainer" class="leaflet-map"></div>

    <StationDetailModal
      v-if="showDetailModal && selectedStation"
      :station="selectedStation"
      :region-id="selectedRegionId"
      :selected-fuel-type="selectedFuelType"
      @close="closeDetailModal"
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
  </div>
</template>

<style scoped>
.map-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.controls {
  display: flex;
  align-items: center;
  gap: 24px;
  flex-wrap: wrap;
}

.region-select select {
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid #ccd2d9;
  min-width: 220px;
}

/* Replaces the old full KPI-grid card: same numbers, but a single line
   folded into the controls bar instead of a separate card - keeps the
   current-state summary visible without eating a whole row of vertical
   space of its own. */
.current-state-inline {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 14px;
  width: 100%;
  padding-top: 10px;
  border-top: 1px solid #eee;
  font-size: 13px;
  color: #445;
}

.current-state-label {
  color: #667;
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
  margin-left: auto;
}

.slider-block {
  flex: 1;
  min-width: 280px;
  display: flex;
  flex-direction: column;
  gap: 4px;
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

/* No sidebar competing for width any more - the map gets the full page
   width, and a taller default height since it's no longer stretched to
   match a sidebar's content height (the old flex row's align-items:
   stretch is gone along with the sidebar itself). */
.leaflet-map {
  width: 100%;
  min-height: 680px;
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

@media (max-width: 860px) {
  .leaflet-map {
    min-height: 480px;
  }
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

.filter-block {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  width: 100%;
  padding-top: 4px;
  border-top: 1px solid #eee;
}

.filter-label {
  font-size: 13px;
  color: #667;
}

.fuel-type-select {
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid #ccd2d9;
  font-size: 13px;
  color: #445;
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
</style>
