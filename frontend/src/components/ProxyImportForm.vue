<script setup>
import { reactive, ref } from 'vue';
import { proxiesApi } from '../api/proxies';

const emit = defineEmits(['imported', 'cancel']);

const form = reactive({ text: '' });
const busy = ref(false);
const error = ref('');
const result = ref(null);

async function handleSubmit() {
  error.value = '';
  result.value = null;
  if (!form.text.trim()) {
    error.value = 'Вставьте хотя бы одну строку';
    return;
  }
  busy.value = true;
  try {
    result.value = await proxiesApi.import(form.text);
    if (result.value.created || result.value.updated) emit('imported');
  } catch (err) {
    error.value = err.response?.data?.error || 'Не удалось выполнить импорт';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop" @click.self="emit('cancel')">
      <form class="card modal-card" @submit.prevent="handleSubmit">
        <h2>Импорт прокси</h2>
        <p class="hint">
          По одной строке вида <code>scheme://user:pass@host:port</code> (например,
          <code>socks5://n64ilbgq:kwm0nnrlqb77@finland3.hshp.twowaysout.monster:31356</code>). Тип —
          socks5, http или https. Строки без <code>user:pass@</code> тоже подходят. Пустые строки и
          строки с <code>#</code> в начале пропускаются. Уже известный host:port обновит существующий
          прокси (новые логин/пароль, автоматически включен), а не создаст дубликат.
        </p>

        <div class="form-row">
          <textarea
            v-model="form.text"
            rows="8"
            spellcheck="false"
            placeholder="socks5://user:pass@host1:1080&#10;socks5://user:pass@host2:1080"
          ></textarea>
        </div>

        <p v-if="error" class="error-text">{{ error }}</p>

        <div v-if="result" class="import-result">
          <p>Создано: {{ result.created }} · Обновлено: {{ result.updated }}</p>
          <div v-if="result.skipped.length" class="skipped-list">
            <p class="hint small">Пропущено ({{ result.skipped.length }}):</p>
            <ul>
              <li v-for="(s, i) in result.skipped" :key="i">
                <code class="mono">{{ s.line }}</code> — {{ s.reason }}
              </li>
            </ul>
          </div>
        </div>

        <div class="modal-actions">
          <button type="button" class="btn secondary" @click="emit('cancel')">Закрыть</button>
          <button type="submit" class="btn" :disabled="busy">{{ busy ? 'Импорт...' : 'Импортировать' }}</button>
        </div>
      </form>
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
  max-width: 560px;
}

.modal-card h2 {
  margin-top: 0;
  font-size: 18px;
}

.hint {
  color: #64748b;
  font-size: 13px;
}

.hint.small {
  font-size: 12px;
}

.hint code,
.mono {
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 12px;
}

.form-row textarea {
  width: 100%;
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 12px;
  resize: vertical;
}

.import-result {
  background: #f8fafc;
  border-radius: 8px;
  padding: 10px 12px;
  margin-top: 8px;
}

.skipped-list ul {
  margin: 4px 0 0;
  padding-left: 18px;
}

.skipped-list li {
  margin-bottom: 4px;
  font-size: 12px;
  word-break: break-all;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 16px;
}

/* Site dark theme (store/theme.js) - this file's own .hint color and
   .import-result background otherwise tie in specificity with main.css's
   generic dark rules and can win on source order alone. */
[data-theme='dark'] .hint {
  color: #94a3b8;
}

[data-theme='dark'] .import-result {
  background: #1e293b;
}

[data-theme='dark'] .form-row textarea {
  background: #1e293b;
  color: #e2e8f0;
  border-color: #334155;
}
</style>
