<script setup>
import { reactive, ref } from 'vue';

const props = defineProps({
  initial: { type: Object, default: null },
});
const emit = defineEmits(['submit', 'cancel']);

const form = reactive({
  username: props.initial?.username || '',
  password: '',
  role: props.initial?.role || 'viewer',
});

const error = ref('');

function handleSubmit() {
  error.value = '';

  if (!props.initial) {
    if (!form.username.trim()) {
      error.value = 'Укажите логин';
      return;
    }
    if (form.password.length < 6) {
      error.value = 'Пароль должен быть не короче 6 символов';
      return;
    }
    emit('submit', {
      username: form.username.trim(),
      password: form.password,
      role: form.role,
    });
    return;
  }

  if (form.password && form.password.length < 6) {
    error.value = 'Пароль должен быть не короче 6 символов';
    return;
  }
  const payload = { role: form.role };
  if (form.password) payload.password = form.password;
  emit('submit', payload);
}
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop" @click.self="emit('cancel')">
      <form class="card modal-card" @submit.prevent="handleSubmit">
        <h2>{{ initial ? 'Изменить пользователя' : 'Новый пользователь' }}</h2>

        <div class="form-row">
          <label for="username">Логин</label>
          <input
            id="username"
            v-model="form.username"
            type="text"
            autocomplete="off"
            :disabled="!!initial"
            required
          />
        </div>

        <div class="form-row">
          <label for="password">
            {{ initial ? 'Новый пароль (оставьте пустым, чтобы не менять)' : 'Пароль' }}
          </label>
          <input id="password" v-model="form.password" type="password" autocomplete="new-password" />
        </div>

        <div class="form-row">
          <label for="role">Роль</label>
          <select id="role" v-model="form.role">
            <option value="viewer">Наблюдатель (только просмотр)</option>
            <option value="admin">Администратор</option>
          </select>
        </div>

        <p v-if="error" class="error-text">{{ error }}</p>

        <div class="modal-actions">
          <button type="button" class="btn secondary" @click="emit('cancel')">Отмена</button>
          <button type="submit" class="btn">Сохранить</button>
        </div>
      </form>
    </div>
  </Teleport>
</template>

<style scoped>
/* Same z-index rationale as RegionForm/ExportPanel: Leaflet's own
   panes/controls use z-index up to 1000 and would otherwise render above a
   lower z-index fixed overlay like this one. */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 40px 16px;
  overflow-y: auto;
  z-index: 2000;
}

.modal-card {
  width: 100%;
  max-width: 420px;
}

.modal-card h2 {
  margin-top: 0;
  font-size: 18px;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 16px;
}
</style>
