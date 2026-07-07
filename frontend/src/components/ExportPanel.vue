<script setup>
import { computed, reactive, ref, watch } from 'vue';

const props = defineProps({
  visible: { type: Boolean, default: false },
  rangeFromMs: { type: Number, default: null },
  rangeToMs: { type: Number, default: null },
  generating: { type: Boolean, default: false },
  fetchProgress: { type: Number, default: 0 },
  encodeProgress: { type: Number, default: 0 },
  resultUrl: { type: String, default: null },
  resultMimeType: { type: String, default: '' },
  videoSupported: { type: Boolean, default: false },
  canShare: { type: Boolean, default: false },
  errorMessage: { type: String, default: '' },
});
const emit = defineEmits(['close', 'generate', 'reset', 'share']);

const form = reactive({
  from: '',
  to: '',
  frameCount: 20,
  frameDelayMs: 600,
  format: 'gif',
});
const validationError = ref('');

const isVideoResult = computed(() => props.resultMimeType.startsWith('video/'));
const downloadName = computed(() => {
  if (isVideoResult.value) {
    return props.resultMimeType.includes('mp4') ? 'fuel-status.mp4' : 'fuel-status.webm';
  }
  return 'fuel-status.gif';
});

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
  emit('generate', { fromMs, toMs, frameCount, frameDelayMs, format: form.format });
}
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop" @click.self="!generating && emit('close')">
      <div class="card modal-card">
        <h2>Экспорт анимации</h2>
        <p class="hint">
          Покажет изменение статуса доступности топлива по станциям (с учётом текущих фильтров
          карты) за выбранный промежуток времени.
        </p>

        <template v-if="!resultUrl">
          <div class="form-row">
            <label>Формат</label>
            <div class="format-choice">
              <label class="radio-option">
                <input type="radio" value="gif" v-model="form.format" :disabled="generating" />
                GIF
              </label>
              <label class="radio-option" :class="{ disabled: !videoSupported }">
                <input
                  type="radio"
                  value="video"
                  v-model="form.format"
                  :disabled="generating || !videoSupported"
                />
                Видео (легче, лучше для Telegram)
              </label>
            </div>
            <p v-if="!videoSupported" class="hint small">
              Браузер не поддерживает запись видео (MediaRecorder) — доступен только GIF.
            </p>
          </div>

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
              <input
                type="number"
                min="2"
                max="60"
                v-model.number="form.frameCount"
                :disabled="generating"
              />
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
              <span>Кодирование</span>
              <progress :value="encodeProgress" max="100"></progress>
              <span>{{ encodeProgress }}%</span>
            </div>
            <p v-if="form.format === 'video'" class="hint small">
              Запись видео идёт в реальном времени, это может занять
              {{ Math.round((form.frameCount * form.frameDelayMs) / 1000) }} сек. и дольше.
            </p>
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
          <video
            v-if="isVideoResult"
            :src="resultUrl"
            class="result-preview"
            controls
            autoplay
            loop
            muted
          ></video>
          <img v-else :src="resultUrl" alt="Анимация статусов доступности топлива" class="result-preview" />

          <p v-if="isVideoResult" class="hint small">
            Скопировать видео напрямую в буфер обмена браузеры не позволяют — используйте
            «Поделиться» (если доступно) или скачайте файл и прикрепите его в Telegram.
          </p>

          <div class="modal-actions">
            <button type="button" class="btn secondary" @click="emit('reset')">Создать заново</button>
            <button v-if="canShare" type="button" class="btn secondary" @click="emit('share')">
              Поделиться
            </button>
            <a :href="resultUrl" :download="downloadName" class="btn">Скачать</a>
            <button type="button" class="btn secondary" @click="emit('close')">Закрыть</button>
          </div>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* Leaflet's own panes/controls use z-index up to 1000 and aren't contained
   in a stacking context, so they'd otherwise render above a lower z-index
   fixed overlay like this one - keep this comfortably above that. */
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

.format-choice {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.radio-option {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  cursor: pointer;
}

.radio-option.disabled {
  color: #99a;
  cursor: not-allowed;
}

.hint.small {
  font-size: 12px;
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

.result-preview {
  max-width: 100%;
  border-radius: 8px;
  border: 1px solid #e5e7eb;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 16px;
  flex-wrap: wrap;
}
</style>
