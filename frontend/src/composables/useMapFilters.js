import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { sortFuelTypes, bestFuelStatus, fuelTypeLabel, CORE_FUEL_TYPES, MAYBE_AVAILABLE_WEIGHT } from '../utils/fuelStatus';

// Same 4 statuses/order used throughout the map page (quick-status
// checkboxes next to the drawer toggle, the full filter list inside the
// drawer, and currentSummary's/status-badge's own counts) - exported
// alongside the composable rather than folded into its return so MapView.vue
// can use it directly in v-for without touching the composable instance.
export const STATUS_KEYS = ['available', 'maybe_available', 'not_available', 'no_data'];

const UNKNOWN_BRAND = 'Без сети';
function brandOf(station) {
  return station.name || UNKNOWN_BRAND;
}

// Compares against CORE_FUEL_TYPES (the default selection, gasoline), not
// against "empty" - selectedFuelTypes starts non-empty (see its own comment
// below), so a bare length check would show the "filter applied" badge
// permanently from the very first load, even though nothing was actually
// changed from the default.
function sameFuelTypeSet(a, b) {
  return a.length === b.length && new Set(b).size === new Set([...a, ...b]).size;
}

/**
 * Status/fuel-type/brand filtering for the map page: everything needed to
 * go from `stationsRef` (the raw snapshot, owned by useRegionSnapshot) to
 * `filteredStations` (what's actually drawn as markers), plus the
 * region-wide `currentSummary` the status badge and share card show.
 *
 * Deliberately has no idea `map`/Leaflet exist - useMapMarkers is the one
 * that watches `filteredStations` to trigger a re-render, keeping this
 * composable a pure filter-state concern that's easy to reason about (and
 * test) on its own.
 */
export function useMapFilters(stationsRef) {
  // Hide "no data" stations by default - by far the most common noise on the map.
  const statusFilters = reactive({
    available: true,
    maybe_available: true,
    not_available: true,
    no_data: false,
  });

  // Gasoline only, not diesel or gas conversions - deliberate, explicit
  // call: gasoline is where this region's real shortage is (verified live:
  // 92 at ~25%, 95 at ~29.5%, against diesel's own ~38.7% over the same
  // stations/period - folding diesel in would have quietly diluted the
  // number away from the fuel drivers are actually struggling to find).
  //
  // Defaults to gasoline checked, not empty - this is the actual filter
  // (see the "Виды топлива" checkboxes in the drawer), not just a fallback:
  // an unchecked filter that silently did nothing until touched would be a
  // broken-feeling control. The user can still pick a different fuel type
  // (or several) explicitly; unchecking everything falls back to this same
  // default rather than reverting to "no filter, show blanket status" (see
  // activeFuelTypes below) - there's deliberately no way back to a
  // diesel/propane-diluted view from this UI anymore.
  const selectedFuelTypes = ref([...CORE_FUEL_TYPES]);

  const availableFuelTypes = computed(() => {
    const set = new Set();
    for (const s of stationsRef.value) {
      for (const f of s.fuelStatuses || []) set.add(f.fuelType);
    }
    return sortFuelTypes(Array.from(set));
  });

  // The fuel type(s) actually driving both marker colors and the aggregate
  // % right now - the user's explicit picks, or CORE_FUEL_TYPES if they've
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

  // Current-state summary for the selected region - always over every
  // loaded station, not just the ones visible under the status/brand
  // checkboxes (those are for decluttering markers, not for changing what
  // "the region's current state" actually is).
  //
  // Pools each station's own reading for activeFuelTypes, each counted as
  // its own data point, rather than each station's one blanket overall
  // status (what this used to do before fuel-type-scoping existed at all).
  // A station's blanket status is usually driven by whichever fuel/source
  // made it green, not necessarily the specific type a given driver needs -
  // "52% of stations are open for business" and "27% chance your gasoline
  // is actually there" are different, both potentially true, claims, and
  // the second is the one a driver checking this badge is actually asking.
  const currentSummary = computed(() => {
    // Used only for availablePct below - with 2 active fuel types by
    // default, summing `counts` itself would come out to ~2x the real
    // station count, which is exactly the bug reported in the Telegram
    // digest cards (see telegramDigestData.js's own fix) and turned out to
    // affect this same live panel + the map share card too.
    const counts = { available: 0, maybe_available: 0, not_available: 0, no_data: 0 };
    const types = activeFuelTypes.value;
    for (const s of stationsRef.value) {
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
    // StationDetailModal's own badge) - sums to exactly stationsRef.value.length,
    // unlike `counts` above. What the live panel's four numbers and the
    // share card's stat tiles actually display.
    const stationCounts = { available: 0, maybe_available: 0, not_available: 0, no_data: 0 };
    for (const s of stationsRef.value) {
      const st = bestFuelStatus(s.fuelStatuses, types);
      stationCounts[st] = (stationCounts[st] || 0) + 1;
    }

    return { counts, stationCounts, availablePct, total: stationsRef.value.length };
  });

  // Keyed by brand name -> visible. Populated lazily as brands show up in
  // loaded snapshots (see the watcher below) rather than rebuilt from
  // scratch each time, so a user's unchecked brands stay unchecked as the
  // time slider moves or live refresh brings in a new snapshot.
  const brandFilters = reactive({});
  const brandSearch = ref('');

  const availableBrands = computed(() =>
    Array.from(new Set(stationsRef.value.map(brandOf))).sort((a, b) => a.localeCompare(b, 'ru'))
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
  // Runs whenever the underlying station list changes (new region, new
  // snapshot) instead of needing every loader to remember to call this
  // itself - loadSnapshot used to call it explicitly right after setting
  // stations.value.
  watch(stationsRef, ensureBrandFilterKeys, { immediate: true });

  function setAllBrands(visible) {
    for (const brand of availableBrands.value) {
      brandFilters[brand] = visible;
    }
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

  // Scroll events don't bubble, but a capturing listener on window still
  // sees them - including scrolling the panel's own internal checkbox list,
  // which should NOT close the panel. Only close for scrolls happening
  // outside it.
  function handleWindowScroll(event) {
    if (brandPanelRef.value && brandPanelRef.value.contains(event.target)) return;
    closeBrandPanel();
  }

  onMounted(() => {
    // Close the teleported brand dropdown rather than let it drift out of
    // place if the page scrolls or the window resizes while it's open.
    window.addEventListener('scroll', handleWindowScroll, true);
    window.addEventListener('resize', closeBrandPanel);
  });
  onBeforeUnmount(() => {
    window.removeEventListener('scroll', handleWindowScroll, true);
    window.removeEventListener('resize', closeBrandPanel);
  });

  // The status checkboxes already sit next to the toggle (see
  // .quick-status-filters in MapView.vue) and stay visible with the drawer
  // closed - but fuel-type and brand filters only live inside the drawer,
  // so closing it after picking either used to leave no sign anything was
  // filtered at all. Drives a small badge next to the toggle for exactly
  // those two.
  const hasActiveExtraFilters = computed(
    () =>
      !sameFuelTypeSet(selectedFuelTypes.value, CORE_FUEL_TYPES) ||
      Object.values(brandFilters).some((visible) => visible === false)
  );

  function resetExtraFilters() {
    selectedFuelTypes.value = [...CORE_FUEL_TYPES];
    setAllBrands(true);
  }

  // Called on a region switch (see MapView.vue's handleRegionChange) -
  // brand names from the previous region don't apply here, so drop them
  // entirely so the checklist starts fresh (all visible, via the
  // stationsRef watcher above re-populating from the new region's own
  // brands) instead of carrying over an unrelated, stale selection.
  function resetForNewRegion() {
    for (const key of Object.keys(brandFilters)) delete brandFilters[key];
    brandSearch.value = '';
    selectedFuelTypes.value = [...CORE_FUEL_TYPES];
  }

  const filteredStations = computed(() =>
    stationsRef.value.filter((s) => statusFilters[effectiveStatus(s)] !== false && brandFilters[brandOf(s)] !== false)
  );

  return {
    brandOf,
    statusFilters,
    selectedFuelTypes,
    availableFuelTypes,
    activeFuelTypes,
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
  };
}
