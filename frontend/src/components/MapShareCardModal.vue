<script setup>
defineProps({
  generating: { type: Boolean, default: false },
  resultUrl: { type: String, default: null },
  canShare: { type: Boolean, default: false },
  clipboardSupported: { type: Boolean, default: false },
  copyFeedback: { type: String, default: '' },
  errorMessage: { type: String, default: '' },
});
const emit = defineEmits(['close', 'regenerate', 'copy', 'share']);
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop" @click.self="emit('close')">
      <div class="card modal-card">
        <h2>Картинка для шаринга</h2>
        <p class="hint">Карта с точками станций и сводкой по текущему моменту.</p>

        <p v-if="generating" class="hint">Генерация...</p>
        <template v-else-if="resultUrl">
          <img :src="resultUrl" alt="Карта со статусами станций" class="card-preview" />
          <div class="card-actions">
            <button type="button" class="btn secondary" @click="emit('regenerate')">Сгенерировать заново</button>
            <button
              v-if="clipboardSupported"
              type="button"
              class="btn secondary"
              @click="emit('copy')"
            >
              {{ copyFeedback === 'ok' ? 'Скопировано ✓' : 'Скопировать в буфер' }}
            </button>
            <button v-if="canShare" type="button" class="btn secondary" @click="emit('share')">
              Поделиться
            </button>
            <a :href="resultUrl" download="map-status.png" class="btn">Скачать</a>
          </div>
          <p v-if="!clipboardSupported" class="hint small">
            Этот браузер не поддерживает копирование картинки в буфер обмена — скачайте файл или
            воспользуйтесь «Поделиться».
          </p>
        </template>

        <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>

        <div class="modal-actions">
          <button type="button" class="btn secondary" @click="emit('close')">Закрыть</button>
        </div>
      </div>
    </div>
  </Teleport>
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
  z-index: 2000;
}

.modal-card {
  width: 100%;
  max-width: 640px;
}

.modal-card h2 {
  margin-top: 0;
  font-size: 18px;
}

.hint.small {
  font-size: 12px;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 16px;
}
</style>
