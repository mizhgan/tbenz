<script setup>
import { computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from './store/auth';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const isAuthenticated = computed(() => auth.isAuthenticated);
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
