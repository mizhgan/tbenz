<script setup>
import { ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuthStore } from '../store/auth';

const username = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

async function handleSubmit() {
  error.value = '';
  loading.value = true;
  try {
    await auth.login(username.value, password.value);
    router.push(route.query.redirect || { name: 'map' });
  } catch (err) {
    error.value = err.response?.data?.error || 'Не удалось войти';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-page">
    <form class="card login-card" @submit.prevent="handleSubmit">
      <h1>⛽ Топливо — Мониторинг</h1>
      <div class="form-row">
        <label for="username">Логин</label>
        <input id="username" v-model="username" type="text" autocomplete="username" required />
      </div>
      <div class="form-row">
        <label for="password">Пароль</label>
        <input
          id="password"
          v-model="password"
          type="password"
          autocomplete="current-password"
          required
        />
      </div>
      <p v-if="error" class="error-text">{{ error }}</p>
      <button class="btn" type="submit" :disabled="loading">
        {{ loading ? 'Вход...' : 'Войти' }}
      </button>
    </form>
  </div>
</template>

<style scoped>
.login-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 80vh;
}

.login-card {
  width: 320px;
}

.login-card h1 {
  font-size: 18px;
  margin-bottom: 20px;
}

.login-card button {
  width: 100%;
}
</style>
