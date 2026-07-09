<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { regionsApi } from '../api/regions';
import { stationMatchingApi } from '../api/stationMatching';
import RegionForm from '../components/RegionForm.vue';

const router = useRouter();
const regions = ref([]);
const sources = ref([]);
const loading = ref(true);
const errorMessage = ref('');
const showForm = ref(false);
const editingRegion = ref(null);
const pollingIds = ref(new Set());

let refreshTimer = null;

async function loadRegions() {
  try {
    regions.value = await regionsApi.list();
  } catch (err) {
    errorMessage.value = err.response?.data?.error || 'Не удалось загрузить районы';
  } finally {
    loading.value = false;
  }
}

// tbank's own poll status has dedicated columns below (it's the primary
// source every region always has); every other registered source (see
// backend's sourceRegistry.js) only shows up in region.sourcePollStatus,
// which otherwise has no label attached to it beyond a bare sourceKey.
async function loadSources() {
  try {
    sources.value = await stationMatchingApi.listSources();
  } catch (err) {
    // Non-fatal - the per-source poll column just falls back to raw keys.
  }
}

function sourceLabel(key) {
  return sources.value.find((s) => s.key === key)?.label || key;
}

function openCreateForm() {
  editingRegion.value = null;
  showForm.value = true;
}

function openEditForm(region) {
  editingRegion.value = region;
  showForm.value = true;
}

async function handleSubmit(payload) {
  try {
    if (editingRegion.value) {
      await regionsApi.update(editingRegion.value._id, payload);
    } else {
      await regionsApi.create(payload);
    }
    showForm.value = false;
    await loadRegions();
  } catch (err) {
    errorMessage.value = err.response?.data?.error || 'Не удалось сохранить район';
  }
}

async function handleDelete(region) {
  if (!confirm(`Удалить район "${region.name}"? История опроса для него будет удалена.`)) return;
  try {
    await regionsApi.remove(region._id);
    await loadRegions();
  } catch (err) {
    errorMessage.value = err.response?.data?.error || 'Не удалось удалить район';
  }
}

async function handlePollNow(region) {
  pollingIds.value.add(region._id);
  try {
    await regionsApi.pollNow(region._id);
    await loadRegions();
  } catch (err) {
    errorMessage.value = err.response?.data?.error || 'Не удалось запросить данные';
  } finally {
    pollingIds.value.delete(region._id);
  }
}

function viewOnMap(region) {
  router.push({ name: 'map', query: { region: region._id } });
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('ru-RU');
}

onMounted(() => {
  loadSources();
  loadRegions();
  refreshTimer = setInterval(loadRegions, 15000);
});

onBeforeUnmount(() => {
  clearInterval(refreshTimer);
});
</script>

<template>
  <div>
    <div class="page-header">
      <h1>Отслеживаемые районы</h1>
      <button class="btn" @click="openCreateForm">+ Добавить район</button>
    </div>

    <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>

    <div class="card">
      <p v-if="loading">Загрузка...</p>
      <p v-else-if="!regions.length">Пока нет ни одного района. Добавьте первый.</p>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Название</th>
              <th>Границы (bbox)</th>
              <th>Интервал</th>
              <th>Статус (tbank)</th>
              <th>Последний опрос</th>
              <th>Станций (tbank)</th>
              <th>Другие источники</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="region in regions" :key="region._id">
              <td>{{ region.name }}</td>
              <td class="mono">
                {{ region.minLat.toFixed(4) }}, {{ region.minLon.toFixed(4) }} →
                {{ region.maxLat.toFixed(4) }}, {{ region.maxLon.toFixed(4) }}
              </td>
              <td>{{ region.pollIntervalMinutes }} мин</td>
              <td>
                <span class="badge" :class="region.active ? 'ok' : 'never'">
                  {{ region.active ? 'активен' : 'выключен' }}
                </span>
                <span
                  v-if="region.lastPollStatus !== 'never'"
                  class="badge"
                  :class="region.lastPollStatus"
                >
                  {{ region.lastPollStatus === 'ok' ? 'ok' : 'ошибка' }}
                </span>
              </td>
              <td>{{ formatDate(region.lastPolledAt) }}</td>
              <td>{{ region.lastPollStationCount }}</td>
              <td>
                <div v-if="!region.sourcePollStatus?.length" class="hint">—</div>
                <div v-for="s in region.sourcePollStatus" :key="s.sourceKey" class="source-status-row">
                  <span class="hint">{{ sourceLabel(s.sourceKey) }}:</span>
                  <span class="badge" :class="s.status">{{ s.status === 'ok' ? 'ok' : s.status === 'error' ? 'ошибка' : 'никогда' }}</span>
                  <span class="hint">{{ s.stationCount }} · {{ formatDate(s.lastPolledAt) }}</span>
                </div>
              </td>
              <td class="actions">
                <button class="btn secondary" @click="viewOnMap(region)">Карта</button>
                <button
                  class="btn secondary"
                  :disabled="pollingIds.has(region._id)"
                  @click="handlePollNow(region)"
                >
                  {{ pollingIds.has(region._id) ? 'Опрос...' : 'Опросить сейчас' }}
                </button>
                <button class="btn secondary" @click="openEditForm(region)">Изменить</button>
                <button class="btn danger" @click="handleDelete(region)">Удалить</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <RegionForm
      v-if="showForm"
      :initial="editingRegion"
      @submit="handleSubmit"
      @cancel="showForm = false"
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

.table-wrap {
  overflow-x: auto;
}

.mono {
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 12px;
}

.actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.source-status-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  white-space: nowrap;
}

.source-status-row:not(:last-child) {
  margin-bottom: 4px;
}
</style>
