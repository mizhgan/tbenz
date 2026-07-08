<script setup>
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from './store/auth';

const auth = useAuthStore();
const router = useRouter();
const isAuthenticated = computed(() => auth.isAuthenticated);

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
    <header v-if="isAuthenticated" class="topbar">
      <div class="brand">⛽ Топливо — Мониторинг</div>
      <nav class="nav">
        <router-link v-if="auth.isAdmin" to="/regions">Районы</router-link>
        <router-link to="/map">Карта</router-link>
        <router-link to="/reports">Отчёты</router-link>
        <router-link v-if="auth.isAdmin" to="/users">Пользователи</router-link>
        <router-link v-if="auth.isAdmin" to="/proxies">Прокси</router-link>
        <router-link to="/settings">Настройки</router-link>
      </nav>
      <div class="user">
        <span>{{ auth.username }}</span>
        <span v-if="auth.isAdmin" class="role-badge">админ</span>
        <button class="link-btn" @click="handleLogout">Выйти</button>
      </div>
    </header>
    <main class="content">
      <router-view />
    </main>
  </div>
</template>

<style>
@import './assets/main.css';
</style>
