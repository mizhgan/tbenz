import { ref, watch } from 'vue';
import L from 'leaflet';
import { stationsApi } from '../api/regions';
import { statusMeta, fuelTypeLabel, CORE_FUEL_TYPES, computeStatusSegments, collapseIsolatedBlips } from '../utils/fuelStatus';

// Leaflet's default autoPan padding is a bare 5px, so it pans just far
// enough for the popup to graze the map container's own top edge - which is
// exactly where the floating status-badge/toggle-bar chrome lives (see
// MapView.vue's .status-badge/.toggle-bar, both position: absolute within
// the same map container). A short popup never reaches that far up, but the
// history ribbon regularly makes popups tall enough to need the pan, and on
// a narrow (mobile) viewport that reliably parks the popup's own close
// button right under the status badge - both fight for the same top-right
// corner. Reserving real vertical room here (taller than the badge, see its
// own top/height) makes autoPan stop below that chrome instead of under it.
const POPUP_AUTOPAN_PADDING_TOP_LEFT = L.point(16, 100);
const POPUP_AUTOPAN_PADDING_BOTTOM_RIGHT = L.point(16, 40);

function formatDateTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('ru-RU');
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

// 24h, not the 7-day window StationDetailModal's own ribbon uses - this one
// has to fit a ~250px popup, and the point here is "is it flaky *right
// now*", not a full week of history (that's what "Подробная информация"
// is for). stationId -> pre-rendered ribbon HTML string, populated lazily
// (see loadRibbon below) - fetched once per station per continuous popup
// open, not eagerly for every marker, since most popups never get opened.
// Persists across a live-refresh's setPopupContent call (see renderMarkers)
// so an already-open popup's ribbon doesn't flash back to a loading
// placeholder every ~20s - but gets evicted on popupclose (see the
// popupclose listener below) so reopening later (this session's data has
// moved on by then) fetches fresh instead of replaying whatever was true
// the first time this station's popup was ever opened.
const RIBBON_LOOKBACK_HOURS = 24;
const ribbonCache = new Map();

// Same row/label/hint structure buildRibbonHtml itself renders (right down
// to the real hint text, which - like the labels - never actually depends
// on the fetch result: CORE_FUEL_TYPES and RIBBON_LOOKBACK_HOURS are both
// known upfront) - only the bar itself is shimmer-placeholder content,
// since that's the one piece that genuinely doesn't exist yet. Matching
// heights exactly means the popup doesn't reflow/jump once the real
// ribbon replaces this - a plain "Loading…" line was noticeably shorter
// than 2 real bar rows, shifting everything below it down the moment data
// arrived.
function ribbonSkeletonHtml() {
  const rows = CORE_FUEL_TYPES.map(
    (fuelType) => `
      <div class="popup-ribbon-row">
        <span class="popup-ribbon-label">${escapeHtml(fuelTypeLabel(fuelType))}</span>
        <div class="popup-ribbon-bar skeleton"></div>
      </div>
    `
  ).join('');
  return `<div class="popup-ribbon">${rows}<div class="popup-ribbon-hint">за последние ${RIBBON_LOOKBACK_HOURS} ч.</div></div>`;
}

// Same segment-computation utilities StationReliabilityTimeline.vue uses
// (computeStatusSegments/collapseIsolatedBlips, both plain framework-
// agnostic functions from utils/fuelStatus.js) - this is a hand-built raw
// HTML equivalent of that Vue component's own ribbon, since Leaflet popup
// content lives outside Vue's render tree entirely and can't just mount a
// component into it (see buildPopupHtml's own doc comment).
function buildRibbonHtml(history) {
  if (!history.length) {
    return `<div class="popup-ribbon popup-ribbon-empty">Нет истории за последние ${RIBBON_LOOKBACK_HOURS} ч.</div>`;
  }
  const rangeStart = new Date(history[0].polledAt).getTime();
  const rangeEnd = new Date(history[history.length - 1].polledAt).getTime();
  const totalMs = rangeEnd - rangeStart;
  const rows = CORE_FUEL_TYPES.map((fuelType) => {
    const segments = collapseIsolatedBlips(computeStatusSegments(history, [fuelType]));
    const segmentsHtml = segments
      .map((seg) => {
        const widthPct = totalMs > 0 ? ((seg.end - seg.start) / totalMs) * 100 : 100;
        const meta = statusMeta(seg.status);
        return `<span class="popup-ribbon-segment" style="flex:0 0 ${widthPct}%;background:${meta.color}" title="${escapeHtml(meta.label)}"></span>`;
      })
      .join('');
    return `
      <div class="popup-ribbon-row">
        <span class="popup-ribbon-label">${escapeHtml(fuelTypeLabel(fuelType))}</span>
        <div class="popup-ribbon-bar">${segmentsHtml}</div>
      </div>
    `;
  }).join('');
  return `<div class="popup-ribbon">${rows}<div class="popup-ribbon-hint">за последние ${RIBBON_LOOKBACK_HOURS} ч.</div></div>`;
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

/**
 * Marker/popup rendering for the map page - turns `filteredStationsRef`
 * (useMapFilters' output) into actual Leaflet circle markers, builds each
 * one's popup HTML, and owns the "which station is the detail modal open
 * for" state that a popup's button click sets.
 *
 * `mapState` is a plain (non-reactive) `{ map, markersLayer }` holder, not
 * a ref - Leaflet's own map/layer instances don't need Vue reactivity, and
 * this composable is constructed during setup(), before MapView.vue's own
 * onMounted has actually created them. Reading `mapState.map` inside a
 * function that only runs later (the filteredStationsRef watcher below,
 * any exposed method) always sees the current value because JS closures
 * capture the object reference, not a snapshot of its properties at
 * construction time.
 */
export function useMapMarkers({ mapState, stationsRef, filteredStationsRef, effectiveStatus, badgeFuelLabelRef }) {
  const selectedStation = ref(null);
  const showDetailModal = ref(false);
  // Only fit the map's view to the loaded stations once per region (see
  // MapView.vue's handleRegionChange, which resets this to false) - without
  // it, every live refresh or filter change would re-center/re-zoom the map
  // out from under someone who's since panned/zoomed manually.
  const hasFitted = ref(false);

  // stationId -> { marker, data } - lets renderMarkers below update markers
  // in place (position/color/tooltip/popup content) instead of clearing and
  // rebuilding the whole layer on every refresh, which used to close any
  // popup a visitor had open the moment the next live poll (or filter
  // change) landed, even though nothing about *that* station necessarily
  // changed. `entry.data` is what buildPopupHtml's bound callback actually
  // reads (see renderMarkers below) - reassigning it on every update is
  // what makes an already-open popup's content refresh in place instead of
  // going stale until it's closed and reopened.
  const markerEntries = new Map();

  function openDetailModal() {
    showDetailModal.value = true;
  }

  function closeDetailModal() {
    showDetailModal.value = false;
  }

  // Popup content replaces the old always-visible sidebar: a compact
  // summary right on the marker, with a button into the same full
  // StationDetailModal as before. Built as an HTML string (Leaflet's own
  // content model) rather than a Vue component, since Leaflet popups
  // aren't part of Vue's render tree - the "Подробная информация" button
  // below is wired up to Vue state via the popupopen handler in
  // renderMarkers(), not a @click binding.
  function buildPopupHtml(s) {
    const meta = statusMeta(effectiveStatus(s));
    const fuelSuffix = ` (${escapeHtml(badgeFuelLabelRef.value)})`;
    const fuelRows = (s.fuelStatuses || [])
      .map((f) => {
        const fm = statusMeta(f.status);
        return `<div class="popup-fuel-row"><span class="popup-dot" style="background:${fm.color}"></span>${escapeHtml(fuelTypeLabel(f.fuelType))}: ${fm.label}</div>`;
      })
      .join('');
    // overallLastTransactionAt (freshest across tbank + every matched
    // secondary source - see Station.js's own doc comment), not tbank's
    // own lastTransactionAt alone - a station last confirmed via tbank a
    // week ago but seen by sberazs 6 hours ago should read "6 hours ago"
    // here, not the week-old tbank-only date.
    const lastTransactionLabel = s.overallLastTransactionAt
      ? formatDateTime(new Date(s.overallLastTransactionAt).getTime())
      : 'нет данных';
    const stationId = String(s.stationId);
    const ribbonHtml = ribbonCache.get(stationId) || ribbonSkeletonHtml();
    return `
      <div class="station-popup">
        <div class="popup-title">${escapeHtml(s.name || 'АЗС')}</div>
        ${s.address ? `<div class="popup-address">${escapeHtml(s.address)}</div>` : ''}
        <div class="popup-status"><span class="popup-dot" style="background:${meta.color}"></span>${meta.label}${fuelSuffix}</div>
        ${ribbonHtml}
        ${fuelRows ? `<div class="popup-fuel-list">${fuelRows}</div>` : ''}
        ${sourcesSummaryHtml(s)}
        <div class="popup-hint">Последняя транзакция: ${escapeHtml(lastTransactionLabel)}</div>
        <button type="button" class="btn secondary popup-detail-btn">Подробная информация</button>
      </div>
    `;
  }

  // Fetched once per station per page session (see ribbonCache's own doc
  // comment) - kicked off from popupopen below, not eagerly for every
  // marker. Re-renders the popup (picking up the now-cached HTML via
  // buildPopupHtml above) only if it's still open by the time the request
  // resolves - a visitor who already moved on shouldn't cause a pointless
  // DOM update, though the fetch itself still finishes and caches so the
  // *next* open of this same station is instant.
  async function loadRibbon(entry) {
    const stationId = String(entry.data.stationId);
    if (ribbonCache.has(stationId)) return;
    try {
      const from = new Date(Date.now() - RIBBON_LOOKBACK_HOURS * 3600 * 1000).toISOString();
      const history = await stationsApi.history(stationId, { from, limit: 2000 });
      ribbonCache.set(stationId, buildRibbonHtml(history));
    } catch {
      // Best-effort - the placeholder just never resolves into a ribbon for
      // this station this session, not worth its own error message inside
      // an already-compact popup.
      ribbonCache.set(stationId, `<div class="popup-ribbon popup-ribbon-empty">Не удалось загрузить историю</div>`);
    }
    if (entry.marker.isPopupOpen()) {
      entry.marker.setPopupContent(buildPopupHtml(entry.data));
      wirePopupContent(entry);
    }
  }

  // Shared by the initial popupopen and by loadRibbon's own content
  // refresh above - both replace the popup's DOM wholesale (Leaflet has no
  // partial-update API for popup content), so the detail button's
  // listener needs re-attaching either time, not just on first open.
  function wirePopupContent(entry) {
    const el = entry.marker.getPopup()?.getElement();
    const btn = el ? el.querySelector('.popup-detail-btn') : null;
    if (btn) btn.addEventListener('click', openDetailModal);
  }

  // Re-sizes markers in place on zoom change rather than calling
  // renderMarkers() again - that clears and rebuilds the whole layer, which
  // would close any popup the user has open mid-zoom for no reason.
  function updateMarkerRadii() {
    if (!mapState.map || !mapState.markersLayer) return;
    const radius = markerRadiusForZoom(mapState.map.getZoom());
    mapState.markersLayer.eachLayer((marker) => marker.setRadius(radius));
  }

  function renderMarkers() {
    if (!mapState.map || !mapState.markersLayer) return;
    const { map, markersLayer } = mapState;
    const radius = markerRadiusForZoom(map.getZoom());
    const seenIds = new Set();

    for (const s of filteredStationsRef.value) {
      const id = String(s.stationId);
      seenIds.add(id);
      const meta = statusMeta(effectiveStatus(s));
      const fuelSuffix = ` (${escapeHtml(badgeFuelLabelRef.value)})`;
      const tooltipText = `${escapeHtml(s.name || 'АЗС')} — ${meta.label}${fuelSuffix}`;

      const existing = markerEntries.get(id);
      if (!existing) {
        const marker = L.circleMarker([s.lat, s.lon], {
          radius,
          // White outline independent of the status color (previously
          // `color` matched `fillColor`, so the "stroke" was invisible as a
          // stroke) - guarantees separation from whatever's directly
          // underneath, since a same-color-as-fill edge blends into
          // equally-colored map features (a red marker over a red/orange
          // road, a green one over a park).
          color: '#fff',
          fillColor: meta.color,
          fillOpacity: 0.85,
          weight: 2,
        });
        // `entry` (not `s` directly) is what the popup callback and
        // popupopen handler below read, and entry.data gets reassigned on
        // every later refresh (see the `else` branch) - so a popup bound
        // this way always shows/reopens with the latest data for this
        // station, not a frozen snapshot from whenever it was first drawn.
        const entry = { marker, data: s };
        marker.bindTooltip(tooltipText);
        marker.bindPopup(() => buildPopupHtml(entry.data), {
          maxWidth: 260,
          minWidth: 220,
          autoPanPaddingTopLeft: POPUP_AUTOPAN_PADDING_TOP_LEFT,
          autoPanPaddingBottomRight: POPUP_AUTOPAN_PADDING_BOTTOM_RIGHT,
        });
        // The button inside the popup isn't part of Vue's render tree (it's
        // raw HTML Leaflet drops into the DOM), so it can't use @click -
        // wire it up imperatively each time this marker's popup actually
        // opens instead.
        marker.on('popupopen', () => {
          selectedStation.value = entry.data;
          wirePopupContent(entry);
          loadRibbon(entry);
        });
        // Evict rather than leaving the entry to answer every future
        // popupopen for this station - see ribbonCache's own doc comment
        // above for why "while this exact popup instance stays open" and
        // "for the rest of the page session" need different lifetimes.
        marker.on('popupclose', () => {
          ribbonCache.delete(String(entry.data.stationId));
        });
        markersLayer.addLayer(marker);
        markerEntries.set(id, entry);
      } else {
        existing.data = s;
        existing.marker.setLatLng([s.lat, s.lon]);
        existing.marker.setStyle({ fillColor: meta.color, radius });
        existing.marker.setTooltipContent(tooltipText);
        // A closed popup already picks up the new `existing.data` next time
        // it opens (see the bindPopup callback above) - an already-open one
        // needs its content refreshed explicitly, which is the whole point
        // of this diff-based render instead of the old clear-and-rebuild:
        // that used to destroy and recreate every marker (and so close
        // every open popup) on each live refresh, even for stations whose
        // data hadn't actually changed.
        if (existing.marker.isPopupOpen()) {
          existing.marker.setPopupContent(buildPopupHtml(existing.data));
          wirePopupContent(existing);
          selectedStation.value = existing.data;
        }
      }
    }

    for (const [id, entry] of markerEntries) {
      if (!seenIds.has(id)) {
        markersLayer.removeLayer(entry.marker);
        markerEntries.delete(id);
      }
    }

    if (stationsRef.value.length && !hasFitted.value) {
      const bounds = L.latLngBounds(stationsRef.value.map((s) => [s.lat, s.lon]));
      map.fitBounds(bounds, { padding: [30, 30] });
      hasFitted.value = true;
    }
  }

  // Replaces the old explicit renderMarkers() calls scattered across
  // loadSnapshot/handleFilterChange/setAllBrands - filteredStationsRef
  // already recomputes whenever stations, status filters, or brand filters
  // change (see useMapFilters), so a single watcher here covers every case
  // that used to need its own manual call, including ones that would
  // otherwise be easy to forget (a new status/brand checkbox wired up
  // later, for instance).
  watch(filteredStationsRef, renderMarkers);

  return {
    selectedStation,
    showDetailModal,
    hasFitted,
    openDetailModal,
    closeDetailModal,
    updateMarkerRadii,
    renderMarkers,
  };
}
