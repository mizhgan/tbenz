import { defineStore } from 'pinia';

const STORAGE_KEY = 'mapBasemapStyle';

// Tile providers, picked from the header switcher (App.vue) - kept here
// (not local to MapView.vue) so the choice persists across
// navigation/reloads and so the header control and the map itself share
// one source of truth without prop-drilling through the router. App.vue's
// v-for over this object is what actually renders the switcher's buttons -
// adding an entry here is enough, no template change needed. See
// MapView.vue's own doc comment on why each style needs different tile
// handling (one filters OSM's own tiles, the others swap providers
// entirely).
export const BASEMAP_STYLES = {
  desaturated: {
    label: 'Обычная',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
    subdomains: 'abc',
    // Only this style needs the CSS filter (see MapView.vue) - OSM's own
    // tiles are the saturated ones being toned down.
    filtered: true,
  },
  light: {
    label: 'Светлая',
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    filtered: false,
  },
  dark: {
    label: 'Тёмная',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    filtered: false,
  },
};

function loadStyle() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw && BASEMAP_STYLES[raw] ? raw : 'desaturated';
  } catch {
    return 'desaturated';
  }
}

export const useMapBasemapStore = defineStore('mapBasemap', {
  state: () => ({
    style: loadStyle(),
  }),
  actions: {
    setStyle(style) {
      if (!BASEMAP_STYLES[style]) return;
      this.style = style;
      try {
        localStorage.setItem(STORAGE_KEY, style);
      } catch {
        // Best-effort - a full localStorage quota or a privacy-mode
        // rejection just means the pick doesn't survive a reload, not a
        // reason to break the switch itself.
      }
    },
  },
});
