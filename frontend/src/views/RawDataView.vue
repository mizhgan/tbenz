<script setup>
import { onMounted, ref } from 'vue';
import { rawDataApi } from '../api/rawData';

const collections = ref([]);
const selectedCollection = ref('');
const filterText = ref('');
const limit = ref(20);
const resultText = ref('');
const count = ref(null);
const loading = ref(false);
const errorMessage = ref('');
const copyFeedback = ref('');

async function loadCollections() {
  try {
    collections.value = await rawDataApi.listCollections();
    if (collections.value.length) selectedCollection.value = collections.value[0];
  } catch (err) {
    errorMessage.value = err.response?.data?.error || 'Не удалось загрузить список коллекций';
  }
}

async function runQuery() {
  if (!selectedCollection.value) return;
  errorMessage.value = '';
  copyFeedback.value = '';
  loading.value = true;
  try {
    const params = { limit: limit.value };
    const trimmed = filterText.value.trim();
    if (trimmed) params.filter = trimmed;
    const { docs, count: n } = await rawDataApi.query(selectedCollection.value, params);
    count.value = n;
    resultText.value = JSON.stringify(docs, null, 2);
  } catch (err) {
    resultText.value = '';
    count.value = null;
    errorMessage.value = err.response?.data?.error || 'Не удалось выполнить запрос';
  } finally {
    loading.value = false;
  }
}

async function copyResult() {
  if (!resultText.value) return;
  try {
    await navigator.clipboard.writeText(resultText.value);
    copyFeedback.value = 'ok';
  } catch (err) {
    copyFeedback.value = 'error';
  }
}

onMounted(loadCollections);
</script>

<template>
  <div>
    <div class="page-header">
      <h1>Сырые данные</h1>
    </div>

    <p class="hint">
      Только для чтения: посмотреть, что реально лежит в базе, по конкретной коллекции — например,
      чтобы свериться, различаются ли <code>externalId</code> у похожих на дубликаты станций.
      Фильтр — обычный MongoDB-запрос в виде JSON, например
      <code>{"name": "Irbis"}</code> или <code>{"address": {"$regex": "Воровского"}}</code>.
    </p>

    <div class="card controls">
      <div class="form-row">
        <label>Коллекция</label>
        <select v-model="selectedCollection">
          <option v-for="c in collections" :key="c" :value="c">{{ c }}</option>
        </select>
      </div>
      <div class="form-row filter-row">
        <label>Фильтр (JSON, необязательно)</label>
        <input v-model="filterText" type="text" placeholder='{"name": "Irbis"}' @keyup.enter="runQuery" />
      </div>
      <div class="form-row limit-row">
        <label>Лимит</label>
        <input v-model.number="limit" type="number" min="1" max="200" />
      </div>
      <button type="button" class="btn" :disabled="loading || !selectedCollection" @click="runQuery">
        {{ loading ? 'Выполняется...' : 'Выполнить' }}
      </button>
    </div>

    <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>

    <div v-if="resultText" class="card result-card">
      <div class="result-header">
        <span class="hint">Найдено: {{ count }}</span>
        <button type="button" class="btn secondary" @click="copyResult">
          {{ copyFeedback === 'ok' ? 'Скопировано ✓' : 'Скопировать' }}
        </button>
      </div>
      <pre class="result-pre">{{ resultText }}</pre>
    </div>
  </div>
</template>

<style scoped>
.page-header {
  margin-bottom: 8px;
}

.page-header h1 {
  font-size: 20px;
  margin: 0;
}

.hint {
  color: #64748b;
  font-size: 13px;
  margin: 0 0 16px;
}

.hint code {
  background: #f1f5f9;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 12px;
}

.controls {
  display: flex;
  align-items: flex-end;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.controls .form-row {
  margin-bottom: 0;
}

.filter-row {
  flex: 1;
  min-width: 260px;
}

.limit-row {
  width: 100px;
}

.result-card {
  padding: 0;
  overflow: hidden;
}

.result-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid #e5e7eb;
}

.result-pre {
  margin: 0;
  padding: 16px;
  max-height: 70vh;
  overflow: auto;
  font-size: 12px;
  font-family: 'SFMono-Regular', Consolas, monospace;
  white-space: pre;
}
</style>
