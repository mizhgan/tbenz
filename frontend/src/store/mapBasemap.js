import { defineStore } from 'pinia';

const STORAGE_KEY = 'mapBasemapStyle';

// Tile providers, picked from the header switcher (App.vue) - kept here
// (not local to MapView.vue) so the choice persists across
// navigation/reloads and so the header control and the map itself share
// one source of truth without prop-drilling through the router. App.vue's
// v-for over this object is what actually renders the switcher's buttons -
// adding an entry here is enough, no template change needed.
//
// "contrast" used to be two separate entries (a light Carto style and a
// dark one) - folded into one now that the site has its own light/dark
// theme toggle (store/theme.js): a *third*, independent axis for "which of
// these two already-similar Carto styles" would have been one control too
// many for what's really the same choice ("give me the muted, high-contrast
// tiles") the site theme should already be answering. resolveBasemapUrl
// below picks the matching Carto variant for whichever theme is active.
//
// "standard" is deliberately plain, unfiltered OSM regardless of site
// theme - earlier versions ran a CSS filter on it (a light-mode desaturate,
// then also a dark-mode invert-based approximation once the theme toggle
// existed) to help markers stand out against busy tiles, but that's not
// what this option is for anymore: it's the familiar, unmodified OSM look,
// full stop. "contrast" is the answer for anyone who wants the
// better-marker-readability experience instead.
// `icon` is what the header switcher actually renders (see App.vue) -
// `label` stays around for the button's title/aria-label so the icon-only
// button is still identifiable without relying on the glyph alone.
export const BASEMAP_STYLES = {
  standard: {
    label: 'Обычная',
    icon: '🗺️',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
    subdomains: 'abc',
  },
  contrast: {
    label: 'Контрастная',
    icon: '◐',
    urls: {
      light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    },
    attribution: '&copy; OpenStreetMap contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
  },
};

// `standard` has one fixed url; `contrast` has one per site theme (see
// the doc comment above) - this is the one place that difference gets
// resolved, so MapView.vue's own tile-layer setup doesn't need to know
// which shape a given style's URL config is in.
export function resolveBasemapUrl(styleKey, theme) {
  const cfg = BASEMAP_STYLES[styleKey] || BASEMAP_STYLES.standard;
  if (cfg.url) return cfg.url;
  return cfg.urls[theme] || cfg.urls.light;
}

function loadStyle() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw && BASEMAP_STYLES[raw] ? raw : 'standard';
  } catch {
    return 'standard';
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
