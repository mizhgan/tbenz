<script setup>
import { reactive, ref } from 'vue';
import ModalForm from './ModalForm.vue';

const props = defineProps({
  initial: { type: Object, default: null },
  // The parent (UsersView.vue) owns the actual create/update request and
  // passes its own useAsyncAction loading state through here - without it,
  // "Сохранить" stayed clickable for the whole request, so a fast double
  // click (or click + Enter) fired two overlapping submits and could create
  // two users instead of one.
  submitting: { type: Boolean, default: false },
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
  <ModalForm
    :title="initial ? 'Изменить пользователя' : 'Новый пользователь'"
    :error="error"
    max-width="420px"
    :submit-disabled="submitting"
    :submit-label="submitting ? 'Сохранение...' : 'Сохранить'"
    @submit="handleSubmit"
    @cancel="emit('cancel')"
  >
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
  </ModalForm>
</template>
