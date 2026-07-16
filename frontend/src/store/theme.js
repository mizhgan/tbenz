import { defineStore } from 'pinia';

const STORAGE_KEY = 'siteTheme';
const THEMES = ['light', 'dark'];

function loadTheme() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return THEMES.includes(raw) ? raw : 'light';
  } catch {
    return 'light';
  }
}

// Global site theme - phase 1 of a "let's start small" plan (see
// MapView.vue/StationDetailModal.vue's own dark-mode CSS): the toggle
// itself is global (this store, the header switch in App.vue) and reflected
// on <html> via data-theme (see App.vue's watcher), but only the map page's
// own chrome and the shared station modal actually have dark styling
// written yet - everything else simply has no [data-theme="dark"] rules to
// react to, so it stays visually light regardless of this setting until a
// later pass extends it.
export const useThemeStore = defineStore('theme', {
  state: () => ({
    theme: loadTheme(),
  }),
  actions: {
    setTheme(theme) {
      if (!THEMES.includes(theme)) return;
      this.theme = theme;
      try {
        localStorage.setItem(STORAGE_KEY, theme);
      } catch {
        // Best-effort, same reasoning as store/mapBasemap.js's setStyle.
      }
    },
  },
});
