<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { regionsApi } from '../api/regions';
import { stationMatchingApi } from '../api/stationMatching';
import RegionForm from '../components/RegionForm.vue';
import PollLogModal from '../components/PollLogModal.vue';
import RawResponseModal from '../components/RawResponseModal.vue';
import { useAsyncAction, useKeyedAsyncAction } from '../composables/useAsyncAction';

const router = useRouter();
const regions = ref([]);
const sources = ref([]);
const loading = ref(true);
const errorMessage = ref('');
const showForm = ref(false);
const editingRegion = ref(null);
// loadRegions/refreshAll keep their own loading/errorMessage above
// (initial-load + 15s background refresh, guarded against overlap via
// regionsRequestToken/pollStatsRequestToken below - this view's own
// setInterval is what needs it; UsersView.vue's identically-shaped
// loadUsers has no recurring timer, only sequential post-action reloads,
// so it doesn't); submit/delete share one instance, handlePollNow is keyed
// (per-region "Опрос..." button).
const { loading: actionLoading, error: actionError, run: runAction } = useAsyncAction();
const { busyIds: pollingIds, error: pollError, run: runPoll } = useKeyedAsyncAction();
// regionId -> array of { sourceKey, attempts24h, errors24h, emptyOk24h,
// lastPolledAt, lastStatus, lastError, lastStationCount } - see backend's
// pollLogService.js. Loaded alongside regions, not embedded in the region
// document itself, since it's a rolling operational stat (SourcePollLog),
// not part of Region.
const pollStatsByRegion = ref(new Map());
const logModal = ref(null);
const rawModal = ref(null);
const copiedUrlKey = ref('');

let refreshTimer = null;

// loadRegions/loadPollStats are each re-triggered from several places
// (onMounted, the 15s refreshTimer, handleSubmit/handleDelete/handlePollNow)
// with no cancellation between overlapping calls - a poll-stats fetch across
// every region (loadPollStats' own Promise.all) can plausibly outlast the
// 15s interval as the region count grows, letting an older tick's response
// land after and overwrite a newer one's. Same request-token pattern as
// ReportsView.vue's loadMetrics, one counter per ref being written so
// guarding one doesn't needlessly drop the other's in-flight call.
let regionsRequestToken = 0;
let pollStatsRequestToken = 0;

async function loadRegions() {
  const myToken = ++regionsRequestToken;
  try {
    const result = await regionsApi.list();
    if (myToken !== regionsRequestToken) return; // superseded by a newer call - discard
    regions.value = result;
  } catch (err) {
    if (myToken !== regionsRequestToken) return;
    errorMessage.value = err.response?.data?.error || 'Не удалось загрузить районы';
  } finally {
    if (myToken === regionsRequestToken) loading.value = false;
  }
}

// tbank's own poll status has dedicated fields directly on Region (it's the
// primary source every region always has); every other registered source
// (see backend's sourceRegistry.js) only shows up in region.sourcePollStatus,
// which otherwise has no label attached to it beyond a bare sourceKey.
async function loadSources() {
  try {
    sources.value = await stationMatchingApi.listSources();
  } catch (err) {
    // Non-fatal - the per-source poll column just falls back to raw keys.
  }
}

function sourceLabel(key) {
  if (key === 'tbank') return 'tbank';
  return sources.value.find((s) => s.key === key)?.label || key;
}

// One row per source (tbank + every entry in region.sourcePollStatus),
// combining each source's own "current state" fields with its 24h
// attempt/error stats (loaded separately, see loadPollStats) - lets the
// template render tbank and every secondary source through the same list
// instead of duplicating markup for tbank's dedicated fields.
function sourceRows(region) {
  const statsByKey = new Map((pollStatsByRegion.value.get(region._id) || []).map((s) => [s.sourceKey, s]));
  const rows = [
    {
      sourceKey: 'tbank',
      status: region.lastPollStatus,
      lastPolledAt: region.lastPolledAt,
      stationCount: region.lastPollStationCount,
      error: region.lastPollError,
      requestUrl: region.lastRequestUrl,
    },
    ...(region.sourcePollStatus || []).map((s) => ({
      sourceKey: s.sourceKey,
      status: s.status,
      lastPolledAt: s.lastPolledAt,
      stationCount: s.stationCount,
      error: s.error,
      requestUrl: s.requestUrl,
    })),
  ];
  return rows.map((r) => ({ ...r, label: sourceLabel(r.sourceKey), stats: statsByKey.get(r.sourceKey) || null }));
}

async function copyUrl(region, row) {
  if (!row.requestUrl) return;
  try {
    await navigator.clipboard.writeText(row.requestUrl);
    const key = `${region._id}:${row.sourceKey}`;
    copiedUrlKey.value = key;
    setTimeout(() => {
      if (copiedUrlKey.value === key) copiedUrlKey.value = '';
    }, 1500);
  } catch {
    // Clipboard API unavailable (e.g. insecure context) - nothing useful to
    // do; the URL is still visible via the raw-response modal.
  }
}

function openRaw(region, sourceKey, label) {
  rawModal.value = { regionId: region._id, sourceKey, label };
}

async function loadPollStats() {
  const myToken = ++pollStatsRequestToken;
  const entries = await Promise.all(
    regions.value.map(async (r) => {
      try {
        return [r._id, await regionsApi.pollStats(r._id)];
      } catch (err) {
        return [r._id, []];
      }
    })
  );
  if (myToken !== pollStatsRequestToken) return; // superseded by a newer call - discard
  pollStatsByRegion.value = new Map(entries);
}

function openLog(region, sourceKey, label) {
  logModal.value = { regionId: region._id, sourceKey, label };
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
  const result = await runAction(
    () => (editingRegion.value ? regionsApi.update(editingRegion.value._id, payload) : regionsApi.create(payload)),
    { fallbackMessage: 'Не удалось сохранить район' }
  );
  if (result !== undefined) {
    showForm.value = false;
    await loadRegions();
  }
}

async function handleDelete(region) {
  if (!confirm(`Удалить район "${region.name}"? История опроса для него будет удалена.`)) return;
  const result = await runAction(() => regionsApi.remove(region._id), { fallbackMessage: 'Не удалось удалить район' });
  if (result !== undefined) await loadRegions();
}

async function handlePollNow(region) {
  const result = await runPoll(region._id, () => regionsApi.pollNow(region._id), {
    fallbackMessage: 'Не удалось запросить данные',
  });
  if (result !== undefined) {
    await loadRegions();
    await loadPollStats();
  }
}

function viewOnMap(region) {
  router.push({ name: 'map', query: { region: region._id } });
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('ru-RU');
}

async function refreshAll() {
  await loadRegions();
  await loadPollStats();
}

onMounted(() => {
  loadSources();
  refreshAll();
  refreshTimer = setInterval(refreshAll, 15000);
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

    <p v-if="errorMessage || actionError || pollError" class="error-text">
      {{ errorMessage || actionError || pollError }}
    </p>

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
              <th>Источники опроса</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="region in regions" :key="region._id">
              <td>
                {{ region.name }}
                <div>
                  <span class="badge" :class="region.active ? 'ok' : 'never'">
                    {{ region.active ? 'активен' : 'выключен' }}
                  </span>
                </div>
              </td>
              <td class="mono">
                {{ region.minLat.toFixed(4) }}, {{ region.minLon.toFixed(4) }} →
                {{ region.maxLat.toFixed(4) }}, {{ region.maxLon.toFixed(4) }}
              </td>
              <td>{{ region.pollIntervalMinutes }} мин</td>
              <td>
                <div v-for="row in sourceRows(region)" :key="row.sourceKey" class="source-status-row">
                  <div class="source-status-line">
                    <span class="hint">{{ row.label }}:</span>
                    <span class="badge" :class="row.status">
                      {{ row.status === 'ok' ? 'ok' : row.status === 'error' ? 'ошибка' : 'никогда' }}
                    </span>
                    <span v-if="row.status === 'ok' && row.stationCount === 0" class="badge warn">0 станций</span>
                    <span class="hint">{{ row.stationCount }} ст. · {{ formatDate(row.lastPolledAt) }}</span>
                    <button type="button" class="link-btn log-link" @click="openLog(region, row.sourceKey, row.label)">
                      журнал
                    </button>
                    <button type="button" class="link-btn log-link" @click="openRaw(region, row.sourceKey, row.label)">
                      сырой ответ
                    </button>
                    <button
                      v-if="row.requestUrl"
                      type="button"
                      class="link-btn log-link"
                      @click="copyUrl(region, row)"
                    >
                      {{ copiedUrlKey === `${region._id}:${row.sourceKey}` ? 'скопировано' : 'копировать URL' }}
                    </button>
                  </div>
                  <div v-if="row.stats" class="hint small">
                    24ч: {{ row.stats.attempts24h }} опрос{{ row.stats.attempts24h === 1 ? '' : 'ов' }},
                    {{ row.stats.errors24h }} ошиб{{ row.stats.errors24h === 1 ? 'ка' : 'ок' }}
                    <span v-if="row.stats.emptyOk24h" class="warn-text">
                      , {{ row.stats.emptyOk24h }}× вернул 0 станций без ошибки
                    </span>
                  </div>
                  <div v-if="row.error" class="hint small error-text-inline" :title="row.error">
                    ⚠ {{ row.error }}
                  </div>
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
                <button class="btn secondary" :disabled="actionLoading" @click="openEditForm(region)">Изменить</button>
                <button class="btn danger" :disabled="actionLoading" @click="handleDelete(region)">Удалить</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <RegionForm
      v-if="showForm"
      :initial="editingRegion"
      :submitting="actionLoading"
      @submit="handleSubmit"
      @cancel="showForm = false"
    />

    <PollLogModal
      v-if="logModal"
      :region-id="logModal.regionId"
      :source-key="logModal.sourceKey"
      :source-label="logModal.label"
      @close="logModal = null"
    />

    <RawResponseModal
      v-if="rawModal"
      :region-id="rawModal.regionId"
      :source-key="rawModal.sourceKey"
      :source-label="rawModal.label"
      @close="rawModal = null"
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
  font-size: 12px;
}

.source-status-row:not(:last-child) {
  margin-bottom: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid #f1f5f9;
}

.source-status-line {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.hint.small {
  font-size: 11px;
  color: #64748b;
}

.warn-text {
  color: #b45309;
}

.error-text-inline {
  color: #991b1b;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-link {
  font-size: 11px;
  color: #2563eb;
  padding: 0;
}

.badge.warn {
  background: #fef3c7;
  color: #b45309;
}

/* Site dark theme (store/theme.js) - this file's own .hint.small color and
   .source-status-row divider otherwise tie in specificity with main.css's
   generic dark rules and can win on source order alone. */
[data-theme='dark'] .hint.small {
  color: #94a3b8;
}

[data-theme='dark'] .source-status-row:not(:last-child) {
  border-bottom-color: #334155;
}

[data-theme='dark'] .badge.warn {
  background: #78350f;
  color: #fcd34d;
}

[data-theme='dark'] .error-text-inline {
  color: #fca5a5;
}

[data-theme='dark'] .warn-text {
  color: #fcd34d;
}

[data-theme='dark'] .log-link {
  color: #7dabf8;
}
</style>
