<script setup>
import { reactive, ref } from 'vue';
import ModalForm from './ModalForm.vue';

const props = defineProps({
  initial: { type: Object, default: null },
});
const emit = defineEmits(['submit', 'cancel']);

const form = reactive({
  label: props.initial?.label || '',
  type: props.initial?.type || 'socks5',
  host: props.initial?.host || '',
  port: props.initial?.port || null,
  username: props.initial?.username || '',
  password: '',
  active: props.initial?.active ?? true,
});

const error = ref('');

function handleSubmit() {
  error.value = '';
  if (!props.initial) {
    if (!form.host.trim()) {
      error.value = 'Укажите адрес прокси';
      return;
    }
    const port = Number(form.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      error.value = 'Порт должен быть числом от 1 до 65535';
      return;
    }
    emit('submit', {
      label: form.label.trim(),
      type: form.type,
      host: form.host.trim(),
      port,
      username: form.username.trim(),
      password: form.password,
      active: form.active,
    });
    return;
  }

  const payload = {
    label: form.label.trim(),
    type: form.type,
    host: form.host.trim(),
    active: form.active,
    username: form.username.trim(),
  };
  if (form.port) {
    const port = Number(form.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      error.value = 'Порт должен быть числом от 1 до 65535';
      return;
    }
    payload.port = port;
  }
  if (form.password) payload.password = form.password;
  emit('submit', payload);
}
</script>

<template>
  <ModalForm
    :title="initial ? 'Редактировать прокси' : 'Новый прокси'"
    :error="error"
    max-width="480px"
    @submit="handleSubmit"
    @cancel="emit('cancel')"
  >
    <div class="form-row">
      <label for="label">Название (необязательно)</label>
      <input id="label" v-model="form.label" type="text" placeholder="Например, DE-1" />
    </div>

    <div class="form-row">
      <label for="type">Тип</label>
      <select id="type" v-model="form.type">
        <option value="socks5">SOCKS5</option>
        <option value="http">HTTP</option>
        <option value="https">HTTPS</option>
      </select>
    </div>

    <div class="bbox-grid">
      <div class="form-row">
        <label for="host">Адрес</label>
        <input id="host" v-model="form.host" type="text" placeholder="1.2.3.4" required />
      </div>
      <div class="form-row">
        <label for="port">Порт</label>
        <input id="port" v-model.number="form.port" type="number" min="1" max="65535" required />
      </div>
    </div>

    <div class="bbox-grid">
      <div class="form-row">
        <label for="username">Логин (необязательно)</label>
        <input id="username" v-model="form.username" type="text" autocomplete="off" />
      </div>
      <div class="form-row">
        <label for="password">{{
          initial ? 'Новый пароль (оставьте пустым, чтобы не менять)' : 'Пароль (необязательно)'
        }}</label>
        <input id="password" v-model="form.password" type="password" autocomplete="new-password" />
      </div>
    </div>

    <div class="form-row form-row--inline">
      <label for="active">
        <input id="active" v-model="form.active" type="checkbox" />
        Активен (использовать для запросов)
      </label>
    </div>
  </ModalForm>
</template>

<style scoped>
.bbox-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 12px;
}

.form-row--inline label {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
