<script setup>
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from './store/auth';

const auth = useAuthStore();
const router = useRouter();
const isAuthenticated = computed(() => auth.isAuthenticated);

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
        <router-link to="/regions">Районы</router-link>
        <router-link to="/map">Карта</router-link>
        <router-link to="/reports">Отчёты</router-link>
      </nav>
      <div class="user">
        <span>{{ auth.username }}</span>
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
