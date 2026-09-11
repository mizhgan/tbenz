<script setup>
import { onMounted, ref } from 'vue';
import { proxiesApi } from '../api/proxies';
import ProxyForm from '../components/ProxyForm.vue';
import ProxyImportForm from '../components/ProxyImportForm.vue';
import { useAsyncAction, useKeyedAsyncAction } from '../composables/useAsyncAction';

const proxies = ref([]);
const loading = ref(true);
const errorMessage = ref('');
const showForm = ref(false);
const showImport = ref(false);
const editingProxy = ref(null);
// loadProxies keeps its own loading/errorMessage above (initial-load
// skeleton, out of scope - see UsersView.vue's same note); one shared
// instance for submit/delete, two keyed ones since check and toggle can
// each be in flight per-row independently of each other.
const { loading: actionLoading, error: actionError, run: runAction } = useAsyncAction();
const { busyIds: checkingIds, error: checkError, run: runCheck } = useKeyedAsyncAction();
const { busyIds: togglingIds, error: toggleError, run: runToggle } = useKeyedAsyncAction();

async function loadProxies() {
  loading.value = true;
  errorMessage.value = '';
  try {
    proxies.value = await proxiesApi.list();
  } catch (err) {
    errorMessage.value = err.response?.data?.error || 'Не удалось загрузить список прокси';
  } finally {
    loading.value = false;
  }
}

function openCreateForm() {
  editingProxy.value = null;
  showForm.value = true;
}

function openEditForm(proxy) {
  editingProxy.value = proxy;
  showForm.value = true;
}

async function handleSubmit(payload) {
  const result = await runAction(
    () => (editingProxy.value ? proxiesApi.update(editingProxy.value.id, payload) : proxiesApi.create(payload)),
    { fallbackMessage: 'Не удалось сохранить прокси' }
  );
  if (result !== undefined) {
    showForm.value = false;
    await loadProxies();
  }
}

async function handleDelete(proxy) {
  if (!confirm(`Удалить прокси «${proxy.label || proxy.host}»?`)) return;
  const result = await runAction(() => proxiesApi.remove(proxy.id), { fallbackMessage: 'Не удалось удалить прокси' });
  if (result !== undefined) await loadProxies();
}

async function handleCheck(proxy) {
  const result = await runCheck(proxy.id, () => proxiesApi.check(proxy.id), { fallbackMessage: 'Не удалось проверить прокси' });
  if (result !== undefined) await loadProxies();
}

async function handleToggle(proxy) {
  const result = await runToggle(proxy.id, () => proxiesApi.update(proxy.id, { active: !proxy.active }), {
    fallbackMessage: 'Не удалось изменить статус прокси',
  });
  if (result !== undefined) await loadProxies();
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('ru-RU');
}

function proxyLabel(proxy) {
  return proxy.label || `${proxy.host}:${proxy.port}`;
}

onMounted(loadProxies);
</script>

<template>
  <div>
    <div class="page-header">
      <h1>Прокси для запросов к источнику данных</h1>
      <div class="header-actions">
        <button class="btn secondary" @click="showImport = true">Импорт из списка</button>
        <button class="btn" @click="openCreateForm">+ Добавить прокси</button>
      </div>
    </div>

    <p class="hint">
      Если есть хотя бы один активный прокси, каждый опрос источника данных случайно выбирает один
      из них. Ошибка запроса помечает прокси; после нескольких ошибок подряд он отключается
      автоматически. Если активных прокси нет, запросы идут напрямую.
    </p>

    <p v-if="errorMessage || actionError || checkError || toggleError" class="error-text">
      {{ errorMessage || actionError || checkError || toggleError }}
    </p>

    <div class="card">
      <p v-if="loading">Загрузка...</p>
      <p v-else-if="!proxies.length">Прокси не настроены — запросы идут напрямую.</p>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Прокси</th>
              <th>Тип</th>
              <th>Статус</th>
              <th>Запросов</th>
              <th>Ошибок подряд</th>
              <th>Последняя проверка</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in proxies" :key="p.id">
              <td class="mono">{{ proxyLabel(p) }}</td>
              <td>{{ p.type.toUpperCase() }}</td>
              <td>
                <span class="badge" :class="p.active ? 'ok' : 'error'">
                  {{ p.active ? 'включен' : 'выключен' }}
                </span>
                <div v-if="!p.active && p.disabledReason" class="sub-note">{{ p.disabledReason }}</div>
                <div v-if="p.lastError" class="sub-note">{{ p.lastError }}</div>
              </td>
              <td>
                {{ p.totalRequests }}
                <div v-if="p.totalRequests" class="sub-note">
                  {{ p.successCount }} успешно / {{ p.failureCount }} ошибок
                </div>
              </td>
              <td>{{ p.consecutiveFailures }}</td>
              <td>
                <template v-if="p.lastCheckStatus === 'never'">не проверялся</template>
                <template v-else>
                  <span class="badge" :class="p.lastCheckStatus === 'ok' ? 'ok' : 'error'">
                    {{ p.lastCheckStatus === 'ok' ? `ok, ${p.lastCheckLatencyMs} мс` : 'ошибка' }}
                  </span>
                  <div class="sub-note">{{ formatDate(p.lastCheckedAt) }}</div>
                  <div v-if="p.lastCheckStatus !== 'ok' && p.lastCheckError" class="sub-note">
                    {{ p.lastCheckError }}
                  </div>
                </template>
              </td>
              <td class="actions">
                <button
                  class="btn secondary"
                  :disabled="checkingIds.has(p.id)"
                  @click="handleCheck(p)"
                >
                  {{ checkingIds.has(p.id) ? 'Проверка...' : 'Проверить' }}
                </button>
                <button
                  class="btn secondary"
                  :disabled="togglingIds.has(p.id)"
                  @click="handleToggle(p)"
                >
                  {{ p.active ? 'Выключить' : 'Включить' }}
                </button>
                <button class="btn secondary" :disabled="actionLoading" @click="openEditForm(p)">Изменить</button>
                <button class="btn danger" :disabled="actionLoading" @click="handleDelete(p)">Удалить</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <ProxyForm
      v-if="showForm"
      :initial="editingProxy"
      :submitting="actionLoading"
      @submit="handleSubmit"
      @cancel="showForm = false"
    />

    <ProxyImportForm
      v-if="showImport"
      @imported="loadProxies"
      @cancel="showImport = false"
    />
  </div>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.page-header h1 {
  font-size: 20px;
  margin: 0;
}

.header-actions {
  display: flex;
  gap: 8px;
}

.hint {
  color: #64748b;
  font-size: 13px;
  margin: -8px 0 16px;
  max-width: 720px;
}

.table-wrap {
  overflow-x: auto;
}

.mono {
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 12px;
}

.sub-note {
  font-size: 11px;
  color: #64748b;
  margin-top: 2px;
  max-width: 220px;
}

.actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

/* Site dark theme (store/theme.js) - this file's own .hint/.sub-note color
   otherwise ties in specificity with main.css's generic dark rule and can
   win on source order alone. */
[data-theme='dark'] .hint,
[data-theme='dark'] .sub-note {
  color: #94a3b8;
}
</style>
