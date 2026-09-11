<script setup>
import { onMounted, ref } from 'vue';
import { rawDataApi } from '../api/rawData';
import { useAsyncAction } from '../composables/useAsyncAction';

const collections = ref([]);
const selectedCollection = ref('');
const filterText = ref('');
const limit = ref(20);
const resultText = ref('');
const count = ref(null);
const { loading, error: errorMessage, run: runQueryAction } = useAsyncAction();
const copyFeedback = ref('');

const dupGroups = ref(null);
const dupCopyFeedback = ref('');
const { loading: dupLoading, error: dupError, run: runFindDuplicates } = useAsyncAction();

async function loadCollections() {
  try {
    collections.value = await rawDataApi.listCollections();
    if (collections.value.length) selectedCollection.value = collections.value[0];
  } catch (err) {
    errorMessage.value = err.response?.data?.error || 'Не удалось загрузить список коллекций';
  }
}

async function findDuplicates() {
  dupCopyFeedback.value = '';
  const result = await runFindDuplicates(() => rawDataApi.duplicateStations(), {
    fallbackMessage: 'Не удалось выполнить поиск дубликатов',
  });
  dupGroups.value = result ? result.groups : null;
}

async function copyDuplicates() {
  if (!dupGroups.value) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(dupGroups.value, null, 2));
    dupCopyFeedback.value = 'ok';
  } catch (err) {
    dupCopyFeedback.value = 'error';
  }
}

// Guards against a slower/older query landing after and overwriting a
// faster/newer one's results - runQuery fires from both the "Выполнить"
// button (disabled while loading) and Enter in the filter input (not
// disabled), so pressing Enter twice while editing the filter can fire two
// overlapping requests. Same request-token pattern as ReportsView.vue's
// loadMetrics.
let requestToken = 0;

async function runQuery() {
  if (!selectedCollection.value) return;
  copyFeedback.value = '';
  const myToken = ++requestToken;
  const params = { limit: limit.value };
  const trimmed = filterText.value.trim();
  if (trimmed) params.filter = trimmed;
  const result = await runQueryAction(() => rawDataApi.query(selectedCollection.value, params), {
    fallbackMessage: 'Не удалось выполнить запрос',
  });
  if (myToken !== requestToken) return; // superseded by a newer call - discard
  if (result) {
    count.value = result.count;
    resultText.value = JSON.stringify(result.docs, null, 2);
  } else {
    resultText.value = '';
    count.value = null;
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

    <div class="card dup-card">
      <div class="dup-header">
        <div>
          <h2>Дубликаты станций</h2>
          <p class="hint hint-tight">
            Станции, у которых несколько документов <code>Station</code> делят один и тот же
            <code>yandexOrgId</code> (с разным <code>externalId</code>) — то есть, скорее всего,
            одна и та же физическая АЗС, задублированная до фикса дедупликации по
            <code>yandexOrgId</code>.
          </p>
        </div>
        <button type="button" class="btn" :disabled="dupLoading" @click="findDuplicates">
          {{ dupLoading ? 'Ищем...' : 'Найти дубликаты' }}
        </button>
      </div>

      <p v-if="dupError" class="error-text">{{ dupError }}</p>

      <template v-if="dupGroups !== null">
        <div class="dup-summary">
          <span class="hint">Найдено групп: {{ dupGroups.length }}</span>
          <button
            v-if="dupGroups.length"
            type="button"
            class="btn secondary"
            @click="copyDuplicates"
          >
            {{ dupCopyFeedback === 'ok' ? 'Скопировано ✓' : 'Скопировать всё как JSON' }}
          </button>
        </div>

        <p v-if="!dupGroups.length" class="hint">Дубликатов не найдено.</p>

        <div v-for="group in dupGroups" :key="group._id" class="dup-group">
          <div class="dup-group-title">
            yandexOrgId: <code>{{ group._id }}</code> — {{ group.count }} записи(-ей)
          </div>
          <table class="dup-table">
            <thead>
              <tr>
                <th>name</th>
                <th>address</th>
                <th>externalId</th>
                <th>lat, lon</th>
                <th>firstSeenAt</th>
                <th>lastSeenAt</th>
                <th>lastStatus</th>
                <th>sourceLinks</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in group.stations" :key="s._id">
                <td>{{ s.name }}</td>
                <td>{{ s.address }}</td>
                <td>{{ s.externalId }}</td>
                <td>{{ s.lat }}, {{ s.lon }}</td>
                <td>{{ s.firstSeenAt }}</td>
                <td>{{ s.lastSeenAt }}</td>
                <td>{{ s.lastStatus }}</td>
                <td>{{ (s.sourceLinks || []).map((l) => `${l.sourceKey}:${l.refId}`).join(', ') || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>

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

.dup-card {
  margin-bottom: 16px;
}

.dup-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.dup-header h2 {
  font-size: 15px;
  margin: 0 0 4px;
}

.hint-tight {
  margin: 0;
  max-width: 640px;
}

.dup-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 12px 0 4px;
}

.dup-group {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #e5e7eb;
}

.dup-group-title {
  font-size: 13px;
  color: #334155;
  margin-bottom: 6px;
}

.dup-group-title code {
  background: #f1f5f9;
  padding: 1px 5px;
  border-radius: 4px;
}

.dup-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.dup-table th,
.dup-table td {
  text-align: left;
  padding: 4px 8px;
  border-bottom: 1px solid #f1f5f9;
  white-space: nowrap;
}

.dup-table th {
  color: #64748b;
  font-weight: 600;
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

/* Site dark theme (store/theme.js) - overrides this file's own .hint/code/
   border colors, which otherwise tie in specificity with main.css's
   generic dark rules and can win on source order alone. */
[data-theme='dark'] .hint {
  color: #94a3b8;
}

[data-theme='dark'] .hint code,
[data-theme='dark'] .dup-group-title code {
  background: #1e293b;
}

[data-theme='dark'] .dup-group {
  border-top-color: #334155;
}

[data-theme='dark'] .dup-group-title {
  color: #cbd5e1;
}

[data-theme='dark'] .dup-table th,
[data-theme='dark'] .dup-table td {
  border-bottom-color: #334155;
}

[data-theme='dark'] .dup-table th {
  color: #94a3b8;
}

[data-theme='dark'] .result-header {
  border-bottom-color: #334155;
}
</style>
