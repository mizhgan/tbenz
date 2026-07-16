<template>
  <div class="not-found">
    <h1>404</h1>
    <p>Страница не найдена.</p>
    <router-link to="/">На главную</router-link>
  </div>
</template>

<style scoped>
.not-found {
  text-align: center;
  margin-top: 80px;
}

.not-found a {
  color: #2563eb;
}

[data-theme='dark'] .not-found a {
  color: #7dabf8;
}
</style>
