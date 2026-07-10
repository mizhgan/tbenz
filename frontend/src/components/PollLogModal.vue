<script setup>
import { onMounted, ref } from 'vue';
import { regionsApi } from '../api/regions';

const props = defineProps({
  regionId: { type: String, required: true },
  sourceKey: { type: String, required: true },
  sourceLabel: { type: String, required: true },
});
const emit = defineEmits(['close']);

const logs = ref([]);
const loading = ref(true);
const errorMessage = ref('');

async function load() {
  loading.value = true;
  errorMessage.value = '';
  try {
    logs.value = await regionsApi.pollLogs(props.regionId, props.sourceKey, 50);
  } catch (err) {
    errorMessage.value = err.response?.data?.error || 'Не удалось загрузить журнал';
  } finally {
    loading.value = false;
  }
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('ru-RU');
}

// A successful poll that returned zero stations is drawn the same way as a
// hard error - it's not one (no exception was thrown), but it's exactly the
// shape a silent block/rate-limit takes, so it deserves the same visual
// attention as an actual error rather than blending in with every other
// "ok" row.
function rowClass(entry) {
  if (entry.status === 'error') return 'error';
  if (entry.status === 'ok' && entry.stationCount === 0) return 'warn';
  return 'ok';
}

onMounted(load);
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop" @click.self="emit('close')">
      <div class="card modal-card">
        <div class="modal-header">
          <div>
            <h2>Журнал опроса: {{ sourceLabel }}</h2>
            <p class="hint">Последние попытки опроса этого источника для района (до 50 записей)</p>
          </div>
          <button type="button" class="link-btn close-btn" @click="emit('close')">✕</button>
        </div>

        <p v-if="loading" class="hint">Загрузка...</p>
        <p v-else-if="errorMessage" class="error-text">{{ errorMessage }}</p>
        <p v-else-if="!logs.length" class="hint">Пока нет записей журнала для этого источника.</p>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Время</th>
                <th>Статус</th>
                <th>Станций</th>
                <th>Ошибка</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in logs" :key="entry._id" :class="rowClass(entry)">
                <td class="mono">{{ formatDate(entry.polledAt) }}</td>
                <td>
                  <span class="badge" :class="entry.status">
                    {{ entry.status === 'ok' ? 'ok' : 'ошибка' }}
                  </span>
                  <span v-if="entry.status === 'ok' && entry.stationCount === 0" class="badge warn">0 станций</span>
                </td>
                <td>{{ entry.stationCount }}</td>
                <td class="error-cell">{{ entry.error || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>

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
  max-width: 720px;
  max-height: calc(100vh - 80px);
  overflow-y: auto;
}

.modal-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
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

.table-wrap {
  overflow-x: auto;
}

.mono {
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 12px;
  white-space: nowrap;
}

.error-cell {
  max-width: 320px;
  font-size: 12px;
  color: #b91c1c;
  white-space: pre-wrap;
  word-break: break-word;
}

tr.warn .error-cell,
tr.warn td {
  background: rgba(217, 119, 6, 0.06);
}

tr.error td {
  background: rgba(220, 38, 38, 0.05);
}

.badge.warn {
  background: rgba(217, 119, 6, 0.15);
  color: #b45309;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}
</style>
