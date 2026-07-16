<script setup>
import { computed, onMounted, ref } from 'vue';
import { regionsApi } from '../api/regions';

const props = defineProps({
  regionId: { type: String, required: true },
  sourceKey: { type: String, required: true },
  sourceLabel: { type: String, required: true },
});
const emit = defineEmits(['close']);

const loading = ref(true);
const errorMessage = ref('');
const result = ref(null);
const copiedField = ref('');

const formattedResponse = computed(() => {
  const raw = result.value?.rawResponse;
  if (!raw) return '';
  // A source that's blocked/challenged sometimes responds 200 OK with an
  // HTML page instead of JSON (see sberazsClient.js's anti-bot comment) -
  // shown as-is rather than JSON.stringify'd into one escaped-quote line,
  // since the whole point of this view is to see exactly what came back.
  if (typeof raw === 'string') return raw;
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return String(raw);
  }
});

async function load() {
  loading.value = true;
  errorMessage.value = '';
  try {
    result.value = await regionsApi.rawResponse(props.regionId, props.sourceKey);
  } catch (err) {
    errorMessage.value = err.response?.data?.error || 'Не удалось загрузить ответ источника';
  } finally {
    loading.value = false;
  }
}

async function copy(text, field) {
  try {
    await navigator.clipboard.writeText(text);
    copiedField.value = field;
    setTimeout(() => {
      if (copiedField.value === field) copiedField.value = '';
    }, 1500);
  } catch {
    // Clipboard API unavailable (e.g. insecure context) - nothing useful to
    // do beyond leaving the text selectable in the textarea/code block.
  }
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('ru-RU');
}

onMounted(load);
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop" @click.self="emit('close')">
      <div class="card modal-card">
        <div class="modal-header">
          <div>
            <h2>Сырой ответ: {{ sourceLabel }}</h2>
            <p v-if="result?.capturedAt" class="hint">Получен: {{ formatDate(result.capturedAt) }}</p>
          </div>
          <button type="button" class="link-btn close-btn" @click="emit('close')">✕</button>
        </div>

        <p v-if="loading" class="hint">Загрузка...</p>
        <p v-else-if="errorMessage" class="error-text">{{ errorMessage }}</p>
        <template v-else>
          <div class="url-row">
            <span class="hint">URL запроса:</span>
            <code class="url-code">{{ result.requestUrl || '—' }}</code>
            <button
              v-if="result.requestUrl"
              type="button"
              class="btn secondary small"
              @click="copy(result.requestUrl, 'url')"
            >
              {{ copiedField === 'url' ? 'Скопировано' : 'Копировать URL' }}
            </button>
          </div>

          <div v-if="result.rawResponse?.truncated" class="hint small truncated-note">
            Ответ обрезан ({{ result.rawResponse.originalLength }} символов) - показана только часть.
          </div>

          <div v-if="formattedResponse" class="response-wrap">
            <pre class="response-body">{{ formattedResponse }}</pre>
          </div>
          <p v-else class="hint">Успешного ответа от этого источника ещё не было.</p>
        </template>

        <div class="modal-actions">
          <button
            v-if="formattedResponse"
            type="button"
            class="btn secondary"
            @click="copy(formattedResponse, 'body')"
          >
            {{ copiedField === 'body' ? 'Скопировано' : 'Копировать ответ' }}
          </button>
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
  max-width: 880px;
  max-height: calc(100vh - 80px);
  overflow-y: auto;
}

.modal-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.modal-header h2 {
  margin: 0 0 4px;
  font-size: 20px;
}

.close-btn {
  font-size: 18px;
  line-height: 1;
  padding: 4px 8px;
}

.url-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.url-code {
  flex: 1 1 auto;
  min-width: 200px;
  padding: 6px 10px;
  background: #f1f5f9;
  border-radius: 6px;
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 12px;
  word-break: break-all;
}

.btn.small {
  padding: 4px 10px;
  font-size: 12px;
}

.truncated-note {
  color: #b45309;
  margin-bottom: 8px;
}

.response-wrap {
  max-height: 50vh;
  overflow: auto;
  background: #0f172a;
  border-radius: 8px;
}

.response-body {
  margin: 0;
  padding: 12px;
  color: #e2e8f0;
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

/* Site dark theme (store/theme.js) - .response-wrap/.response-body are
   deliberately a permanently-dark code block regardless of theme (left
   untouched), just .url-code's light background needs a dark variant. */
[data-theme='dark'] .url-code {
  background: #1e293b;
  color: #e2e8f0;
}

[data-theme='dark'] .truncated-note {
  color: #fcd34d;
}
</style>
