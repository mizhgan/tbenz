<script setup>
import { onMounted, ref } from 'vue';
import { usersApi } from '../api/users';
import { useAuthStore } from '../store/auth';
import UserForm from '../components/UserForm.vue';
import { useAsyncAction } from '../composables/useAsyncAction';

const auth = useAuthStore();

const users = ref([]);
const loading = ref(true);
const errorMessage = ref('');
const showForm = ref(false);
const editingUser = ref(null);
// Separate from loadUsers's own loading/errorMessage above - that pair
// drives the initial-load skeleton (loading starts true), which
// useAsyncAction's loading (starts false) would break a beat of on mount.
// This one's just for save/delete, which - like before this composable
// existed - show an error but no loading indicator of their own.
const { error: actionError, run: runAction } = useAsyncAction();

async function loadUsers() {
  loading.value = true;
  errorMessage.value = '';
  try {
    users.value = await usersApi.list();
  } catch (err) {
    errorMessage.value = err.response?.data?.error || 'Не удалось загрузить пользователей';
  } finally {
    loading.value = false;
  }
}

function openCreateForm() {
  editingUser.value = null;
  showForm.value = true;
}

function openEditForm(user) {
  editingUser.value = user;
  showForm.value = true;
}

async function handleSubmit(payload) {
  const result = await runAction(
    () => (editingUser.value ? usersApi.update(editingUser.value.id, payload) : usersApi.create(payload)),
    { fallbackMessage: 'Не удалось сохранить пользователя' }
  );
  if (result !== undefined) {
    showForm.value = false;
    await loadUsers();
  }
}

async function handleDelete(user) {
  if (!confirm(`Удалить пользователя «${user.username}»?`)) return;
  const result = await runAction(() => usersApi.remove(user.id), { fallbackMessage: 'Не удалось удалить пользователя' });
  if (result !== undefined) await loadUsers();
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('ru-RU');
}

onMounted(loadUsers);
</script>

<template>
  <div>
    <div class="page-header">
      <h1>Пользователи</h1>
      <button class="btn" @click="openCreateForm">+ Добавить пользователя</button>
    </div>

    <p v-if="errorMessage || actionError" class="error-text">{{ errorMessage || actionError }}</p>

    <div class="card">
      <p v-if="loading">Загрузка...</p>
      <p v-else-if="!users.length">Пока нет ни одного пользователя.</p>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Логин</th>
              <th>Роль</th>
              <th>Создан</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in users" :key="u.id">
              <td>{{ u.username }}</td>
              <td>
                <span class="badge" :class="u.role === 'admin' ? 'ok' : 'never'">
                  {{ u.role === 'admin' ? 'администратор' : 'наблюдатель' }}
                </span>
              </td>
              <td>{{ formatDate(u.createdAt) }}</td>
              <td class="actions">
                <button class="btn secondary" @click="openEditForm(u)">Изменить</button>
                <button
                  class="btn danger"
                  :disabled="u.id === auth.userId"
                  :title="u.id === auth.userId ? 'Нельзя удалить свою учётную запись' : ''"
                  @click="handleDelete(u)"
                >
                  Удалить
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <UserForm
      v-if="showForm"
      :initial="editingUser"
      @submit="handleSubmit"
      @cancel="showForm = false"
    />
  </div>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.page-header h1 {
  font-size: 20px;
  margin: 0;
}

.table-wrap {
  overflow-x: auto;
}

.actions {
  display: flex;
  gap: 6px;
}
</style>
