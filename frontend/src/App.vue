<script setup>
import { computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from './store/auth';
import { useMapBasemapStore, BASEMAP_STYLES } from './store/mapBasemap';
import { useThemeStore } from './store/theme';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const isAuthenticated = computed(() => auth.isAuthenticated);
// Global (not map-page-local) and visible to every visitor, logged in or
// not - a deliberate "let's just try it and see" experiment comparing two
// approaches to the same problem (markers getting lost in busy street-level
// tiles - see MapView.vue's own doc comment): filtering OSM's own tiles vs.
// swapping to an already-muted provider. Lives in the header rather than
// the map's own filter drawer so it's discoverable regardless of which
// page you land on first, even though it only visibly does anything once
// you're looking at the map itself.
const basemap = useMapBasemapStore();
// Site-wide light/dark theme (store/theme.js) - reflected onto <html> via
// data-theme below so both regular CSS (MapView.vue's own chrome) and
// <Teleport>-ed content (StationDetailModal.vue, still a descendant of
// <html> in the final DOM regardless of where it's teleported from) can
// react to it with a plain [data-theme="dark"] ancestor selector. `immediate`
// so a dark preference saved from a previous visit is applied on first
// paint, not just on the next toggle.
const theme = useThemeStore();
watch(
  () => theme.theme,
  (value) => {
    document.documentElement.setAttribute('data-theme', value);
  },
  { immediate: true }
);
// The map page wants to fill the viewport edge-to-edge below the header
// (see .content--full-bleed) - every other page keeps .content's normal
// padding.
const isFullBleed = computed(() => route.name === 'map');

onMounted(() => {
  // Locally cached role can be stale (pre-role token, or a role change made
  // elsewhere) - refresh it from the backend once on load.
  if (auth.isAuthenticated) {
    auth.fetchMe().catch(() => {});
  }
});

function handleLogout() {
  auth.logout();
  router.push({ name: 'login' });
}
</script>

<template>
  <div class="layout">
    <header class="topbar">
      <div class="brand">⛽ Топливо — Мониторинг</div>
      <nav class="nav">
        <router-link v-if="auth.isAdmin" to="/regions">Районы</router-link>
        <router-link to="/map">Карта</router-link>
        <router-link to="/reports">Отчёты</router-link>
        <router-link v-if="auth.isAdmin" to="/users">Пользователи</router-link>
        <router-link v-if="auth.isAdmin" to="/proxies">Прокси</router-link>
        <router-link v-if="auth.isAdmin" to="/telegram">Telegram</router-link>
        <router-link v-if="auth.isAdmin" to="/stations">Станции</router-link>
        <router-link v-if="auth.isAdmin" to="/station-matching">Сопоставление</router-link>
        <router-link v-if="auth.isAdmin" to="/raw-data">Сырые данные</router-link>
        <router-link to="/settings">Настройки</router-link>
      </nav>
      <div class="user">
        <div class="pill-switch" title="Стиль подложки карты">
          <button
            v-for="(cfg, key) in BASEMAP_STYLES"
            :key="key"
            type="button"
            class="pill-switch__btn"
            :class="{ 'pill-switch__btn--active': basemap.style === key }"
            @click="basemap.setStyle(key)"
          >
            {{ cfg.label }}
          </button>
        </div>
        <div class="pill-switch" title="Тема сайта">
          <button
            type="button"
            class="pill-switch__btn"
            :class="{ 'pill-switch__btn--active': theme.theme === 'light' }"
            @click="theme.setTheme('light')"
          >
            Светлая
          </button>
          <button
            type="button"
            class="pill-switch__btn"
            :class="{ 'pill-switch__btn--active': theme.theme === 'dark' }"
            @click="theme.setTheme('dark')"
          >
            Тёмная
          </button>
        </div>
        <a
          class="telegram-link"
          href="https://t.me/tbenzin"
          target="_blank"
          rel="noopener"
          title="Канал в Telegram"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
            <path
              d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.161c-.18 1.897-.962 6.502-1.359 8.627-.168.9-.499 1.201-.82 1.23-.696.064-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.242-1.865-.44-.751-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.831-2.529 6.998-3.015 3.332-1.386 4.025-1.627 4.477-1.635.099-.002.321.023.465.14.121.098.155.23.171.323.016.093.037.306.02.472z"
            />
          </svg>
          <span class="telegram-link__label">Telegram</span>
        </a>
        <template v-if="isAuthenticated">
          <span>{{ auth.username }}</span>
          <span v-if="auth.isAdmin" class="role-badge">админ</span>
          <button class="link-btn" @click="handleLogout">Выйти</button>
        </template>
        <router-link v-else to="/login">Войти</router-link>
      </div>
    </header>
    <main class="content" :class="{ 'content--full-bleed': isFullBleed }">
      <router-view />
    </main>
  </div>
</template>

<style>
@import './assets/main.css';
</style>
