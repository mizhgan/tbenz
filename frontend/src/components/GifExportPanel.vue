<script setup>
import { reactive, ref, watch } from 'vue';

const props = defineProps({
  visible: { type: Boolean, default: false },
  rangeFromMs: { type: Number, default: null },
  rangeToMs: { type: Number, default: null },
  generating: { type: Boolean, default: false },
  fetchProgress: { type: Number, default: 0 },
  encodeProgress: { type: Number, default: 0 },
  resultUrl: { type: String, default: null },
  errorMessage: { type: String, default: '' },
});
const emit = defineEmits(['close', 'generate', 'reset']);

const form = reactive({
  from: '',
  to: '',
  frameCount: 20,
  frameDelayMs: 600,
});
const validationError = ref('');

function msToLocalInputValue(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

watch(
  () => props.visible,
  (visible) => {
    if (visible && props.rangeFromMs && props.rangeToMs) {
      form.from = msToLocalInputValue(props.rangeFromMs);
      form.to = msToLocalInputValue(props.rangeToMs);
      validationError.value = '';
    }
  },
  { immediate: true }
);

function handleGenerate() {
  validationError.value = '';
  const fromMs = new Date(form.from).getTime();
  const toMs = new Date(form.to).getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    validationError.value = 'Укажите корректные даты начала и конца';
    return;
  }
  if (fromMs >= toMs) {
    validationError.value = 'Дата начала должна быть раньше даты конца';
    return;
  }
  const frameCount = Number(form.frameCount);
  if (!Number.isInteger(frameCount) || frameCount < 2 || frameCount > 60) {
    validationError.value = 'Число кадров должно быть от 2 до 60';
    return;
  }
  const frameDelayMs = Number(form.frameDelayMs);
  if (!Number.isFinite(frameDelayMs) || frameDelayMs < 100) {
    validationError.value = 'Задержка кадра должна быть не меньше 100 мс';
    return;
  }
  emit('generate', { fromMs, toMs, frameCount, frameDelayMs });
}
</script>

<template>
  <div class="modal-backdrop" @click.self="!generating && emit('close')">
    <div class="card modal-card">
      <h2>Экспорт GIF-анимации</h2>
      <p class="hint">
        Покажет изменение статуса доступности топлива по станциям (с учётом текущих фильтров карты)
        за выбранный промежуток времени.
      </p>

      <template v-if="!resultUrl">
        <div class="grid">
          <div class="form-row">
            <label>С</label>
            <input type="datetime-local" v-model="form.from" :disabled="generating" />
          </div>
          <div class="form-row">
            <label>По</label>
            <input type="datetime-local" v-model="form.to" :disabled="generating" />
          </div>
          <div class="form-row">
            <label>Число кадров</label>
            <input type="number" min="2" max="60" v-model.number="form.frameCount" :disabled="generating" />
          </div>
          <div class="form-row">
            <label>Задержка кадра (мс)</label>
            <input
              type="number"
              min="100"
              step="100"
              v-model.number="form.frameDelayMs"
              :disabled="generating"
            />
          </div>
        </div>

        <p v-if="validationError" class="error-text">{{ validationError }}</p>
        <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>

        <div v-if="generating" class="progress-block">
          <div class="progress-row">
            <span>Загрузка данных</span>
            <progress :value="fetchProgress" max="100"></progress>
            <span>{{ fetchProgress }}%</span>
          </div>
          <div class="progress-row">
            <span>Кодирование GIF</span>
            <progress :value="encodeProgress" max="100"></progress>
            <span>{{ encodeProgress }}%</span>
          </div>
        </div>

        <div class="modal-actions">
          <button type="button" class="btn secondary" :disabled="generating" @click="emit('close')">
            Закрыть
          </button>
          <button type="button" class="btn" :disabled="generating" @click="handleGenerate">
            {{ generating ? 'Генерация...' : 'Сгенерировать' }}
          </button>
        </div>
      </template>

      <template v-else>
        <img :src="resultUrl" alt="GIF-анимация статусов доступности топлива" class="gif-preview" />
        <div class="modal-actions">
          <button type="button" class="btn secondary" @click="emit('reset')">Создать заново</button>
          <a :href="resultUrl" download="fuel-status.gif" class="btn">Скачать GIF</a>
          <button type="button" class="btn secondary" @click="emit('close')">Закрыть</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 40px 16px;
  overflow-y: auto;
  z-index: 100;
}

.modal-card {
  width: 100%;
  max-width: 520px;
}

.modal-card h2 {
  margin-top: 0;
  font-size: 18px;
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 12px;
}

.progress-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 12px 0;
}

.progress-row {
  display: grid;
  grid-template-columns: 120px 1fr 40px;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.progress-row progress {
  width: 100%;
}

.gif-preview {
  max-width: 100%;
  border-radius: 8px;
  border: 1px solid #e5e7eb;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 16px;
}
</style>
