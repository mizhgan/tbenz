<script setup>
import { reactive, ref } from 'vue';
import { proxiesApi } from '../api/proxies';
import { useAsyncAction } from '../composables/useAsyncAction';
import ModalForm from './ModalForm.vue';

const emit = defineEmits(['imported', 'cancel']);

const form = reactive({ text: '' });
const { loading: busy, error, run } = useAsyncAction();
const result = ref(null);

async function handleSubmit() {
  error.value = '';
  result.value = null;
  if (!form.text.trim()) {
    error.value = 'Вставьте хотя бы одну строку';
    return;
  }
  const imported = await run(() => proxiesApi.import(form.text), { fallbackMessage: 'Не удалось выполнить импорт' });
  if (imported) {
    result.value = imported;
    if (imported.created || imported.updated) emit('imported');
  }
}
</script>

<template>
  <ModalForm
    title="Импорт прокси"
    :error="error"
    cancel-label="Закрыть"
    :submit-label="busy ? 'Импорт...' : 'Импортировать'"
    :submit-disabled="busy"
    @submit="handleSubmit"
    @cancel="emit('cancel')"
  >
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
  </ModalForm>
</template>

<style scoped>
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
