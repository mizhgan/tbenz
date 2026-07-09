<script setup>
import { computed, onMounted, ref } from 'vue';
import { stationMatchingApi } from '../api/stationMatching';
import { statusMeta, fuelTypeLabel } from '../utils/fuelStatus';

const sources = ref([]);
const selectedSourceKey = ref('');
const unmatched = ref([]);
const matched = ref([]);
const loading = ref(true);
const errorMessage = ref('');
const busyIds = ref(new Set());

const searchQuery = ref('');
const onlyWithCandidates = ref(false);

async function loadAll() {
  if (!selectedSourceKey.value) return;
  loading.value = true;
  errorMessage.value = '';
  try {
    const [unmatchedRes, matchedRes] = await Promise.all([
      stationMatchingApi.listUnmatched(selectedSourceKey.value),
      stationMatchingApi.listMatched(selectedSourceKey.value),
    ]);
    unmatched.value = unmatchedRes;
    matched.value = matchedRes;
  } catch (err) {
    errorMessage.value = err.response?.data?.error || 'Не удалось загрузить список станций';
  } finally {
    loading.value = false;
  }
}

async function loadSourcesAndAll() {
  loading.value = true;
  errorMessage.value = '';
  try {
    sources.value = await stationMatchingApi.listSources();
    selectedSourceKey.value = sources.value[0]?.key || '';
    await loadAll();
  } catch (err) {
    errorMessage.value = err.response?.data?.error || 'Не удалось загрузить список источников';
    loading.value = false;
  }
}

// Cards with at least one candidate are what actually need a decision -
// float them to the top so the (often much longer) tail of "nothing found
// nearby" cards doesn't bury them.
const filteredUnmatched = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  let list = unmatched.value;
  if (q) {
    list = list.filter(
      (g) => (g.name || '').toLowerCase().includes(q) || (g.address || '').toLowerCase().includes(q)
    );
  }
  if (onlyWithCandidates.value) {
    list = list.filter((g) => g.suggestions.length > 0);
  }
  return [...list].sort((a, b) => (a.suggestions.length > 0 ? 0 : 1) - (b.suggestions.length > 0 ? 0 : 1));
});

// Every action below updates local state immediately instead of reloading
// the whole page - a full listUnmatched reload recomputes match candidates
// (haversine + name-similarity) for every single unmatched entry server-side,
// which is the slow part (seconds, not milliseconds) and was forcing the
// entire page to flash to a loading state after every click.
async function handleMatch(secondaryId, stationId) {
  busyIds.value.add(secondaryId);
  errorMessage.value = '';
  const idx = unmatched.value.findIndex((g) => g.id === secondaryId);
  const removed = idx !== -1 ? unmatched.value.splice(idx, 1)[0] : null;
  try {
    await stationMatchingApi.match(selectedSourceKey.value, secondaryId, stationId);
    // Only the matched table needs a refresh - it's a cheap lookup (no
    // per-item candidate search), unlike unmatched.
    matched.value = await stationMatchingApi.listMatched(selectedSourceKey.value);
  } catch (err) {
    if (removed) unmatched.value.splice(idx, 0, removed);
    errorMessage.value = err.response?.data?.error || 'Не удалось сопоставить станцию';
  } finally {
    busyIds.value.delete(secondaryId);
  }
}

async function handleIgnore(secondaryId) {
  busyIds.value.add(secondaryId);
  errorMessage.value = '';
  const idx = unmatched.value.findIndex((g) => g.id === secondaryId);
  const removed = idx !== -1 ? unmatched.value.splice(idx, 1)[0] : null;
  try {
    await stationMatchingApi.ignore(selectedSourceKey.value, secondaryId);
  } catch (err) {
    if (removed) unmatched.value.splice(idx, 0, removed);
    errorMessage.value = err.response?.data?.error || 'Не удалось скрыть станцию';
  } finally {
    busyIds.value.delete(secondaryId);
  }
}

async function handleUnmatch(secondaryId) {
  if (!confirm('Отменить сопоставление? Объединённые данные останутся в истории, новые опросы перестанут объединяться.')) return;
  busyIds.value.add(secondaryId);
  errorMessage.value = '';
  const idx = matched.value.findIndex((g) => g.id === secondaryId);
  const removed = idx !== -1 ? matched.value.splice(idx, 1)[0] : null;
  try {
    await stationMatchingApi.unmatch(selectedSourceKey.value, secondaryId);
    // Unlike match/ignore above, this one station needs to reappear in the
    // unmatched queue with freshly computed candidates - only a full
    // listUnmatched recompute provides that. Runs in the background (no
    // loading spinner) since unmatching is a rarer action than confirming.
    unmatched.value = await stationMatchingApi.listUnmatched(selectedSourceKey.value);
  } catch (err) {
    if (removed) matched.value.splice(idx, 0, removed);
    errorMessage.value = err.response?.data?.error || 'Не удалось отменить сопоставление';
  } finally {
    busyIds.value.delete(secondaryId);
  }
}

function fuelTypesLabel(types) {
  return (types || []).map(fuelTypeLabel).join(', ') || '—';
}

const selectedSourceLabel = computed(
  () => sources.value.find((s) => s.key === selectedSourceKey.value)?.label || ''
);

async function handleSourceChange() {
  searchQuery.value = '';
  await loadAll();
}

onMounted(loadSourcesAndAll);
</script>

<template>
  <div>
    <div class="page-header">
      <h1>Сопоставление станций{{ selectedSourceLabel ? ` (${selectedSourceLabel})` : '' }}</h1>
      <div class="header-actions">
        <label v-if="sources.length > 1" class="source-picker">
          <span class="hint">Источник:</span>
          <select v-model="selectedSourceKey" @change="handleSourceChange">
            <option v-for="s in sources" :key="s.key" :value="s.key">{{ s.label }}</option>
          </select>
        </label>
        <button class="btn secondary" :disabled="loading" @click="loadAll">Обновить</button>
      </div>
    </div>

    <p class="hint">
      Дополнительный источник данных о наличии топлива ({{ selectedSourceLabel || 'источник' }}) не
      даёт общего идентификатора со станциями tbank, поэтому сопоставление станций делается вручную:
      для каждой новой станции источника ниже показаны ближайшие кандидаты по расстоянию и похожести
      названия. После подтверждения статус этой станции дальше объединяется со статусом tbank при
      каждом опросе района — согласие источников даёт подтверждённый статус, а расхождение
      показывается как «возможно доступно», а не выбирается наугад.
    </p>

    <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>
    <p v-if="loading" class="hint">Загрузка...</p>

    <template v-else>
      <div class="card section">
        <div class="section-header">
          <h2>Требуют сопоставления ({{ unmatched.length }})</h2>
          <div class="filters">
            <input v-model="searchQuery" type="text" placeholder="Поиск по названию/адресу" />
            <label class="checkbox-label">
              <input v-model="onlyWithCandidates" type="checkbox" />
              Только с кандидатами
            </label>
          </div>
        </div>
        <p v-if="!unmatched.length" class="hint">Несопоставленных станций нет.</p>
        <p v-else-if="!filteredUnmatched.length" class="hint">Ничего не найдено по этому фильтру.</p>
        <p v-else-if="filteredUnmatched.length !== unmatched.length" class="hint small">
          Показано {{ filteredUnmatched.length }} из {{ unmatched.length }}.
        </p>

        <div
          v-for="g in filteredUnmatched"
          :key="g.id"
          class="entry-card"
          :class="{ 'has-candidates': g.suggestions.length > 0 }"
        >
          <div class="entry-header">
            <div>
              <span class="source-tag">{{ selectedSourceLabel || 'источник' }}</span>
              <strong class="entry-name">{{ g.name || 'Без названия' }}</strong>
              <span v-if="g.brand && g.brand !== g.name" class="muted"> ({{ g.brand }})</span>
              <div class="hint small">{{ g.address || 'адрес неизвестен' }}</div>
            </div>
            <div class="entry-status">
              <span class="badge-dot" :style="{ background: statusMeta(g.status).color }"></span>
              {{ statusMeta(g.status).label }}
              <span v-if="g.status !== 'not_available'" class="muted"> · {{ fuelTypesLabel(g.fuelTypes) }}</span>
              <div v-if="g.conflict" class="hint small conflict-note">
                у источника есть внутреннее расхождение отчётов: «{{ g.conflict }}»
              </div>
            </div>
          </div>

          <p v-if="!g.suggestions.length" class="hint small no-candidates-note">
            Рядом не нашлось ни одной станции tbank — возможно, она не входит ни в один
            отслеживаемый район, или её ещё не видел опрос tbank.
          </p>
          <ul v-else class="candidates">
            <li v-for="s in g.suggestions" :key="s.stationId">
              <div class="candidate-info">
                <span class="source-tag tbank-tag">tbank</span>
                <strong>{{ s.name || 'АЗС' }}</strong>
                <span class="muted">{{ s.address }}</span>
                <span class="hint small">
                  {{ s.distanceMeters }} м · схожесть названия {{ Math.round(s.nameSimilarity * 100) }}%
                  <template v-if="s.alreadyMatched"> · уже сопоставлена с другой станцией {{ selectedSourceLabel || 'источника' }}</template>
                </span>
              </div>
              <button
                type="button"
                class="btn success"
                :disabled="busyIds.has(g.id)"
                @click="handleMatch(g.id, s.stationId)"
              >
                Это та же станция
              </button>
            </li>
          </ul>

          <div class="entry-actions">
            <button type="button" class="btn ghost" :disabled="busyIds.has(g.id)" @click="handleIgnore(g.id)">
              Не станция / нет соответствия
            </button>
          </div>
        </div>
      </div>

      <div class="card section">
        <h2>Подтверждённые сопоставления ({{ matched.length }})</h2>
        <p v-if="!matched.length" class="hint">Пока ни одна станция не сопоставлена.</p>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{{ selectedSourceLabel || 'Источник' }}</th>
                <th>Станция tbank</th>
                <th>Статус станции (объединённый)</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="g in matched" :key="g.id">
                <td>
                  {{ g.name || 'Без названия' }}
                  <div class="hint small">{{ g.address }}</div>
                </td>
                <td>
                  <template v-if="g.station">
                    {{ g.station.name || 'АЗС' }}
                    <div class="hint small">{{ g.station.address }}</div>
                  </template>
                  <span v-else class="hint small">станция удалена</span>
                </td>
                <td>
                  <template v-if="g.station">
                    <span class="badge-dot" :style="{ background: statusMeta(g.station.lastStatus).color }"></span>
                    {{ statusMeta(g.station.lastStatus).label }}
                  </template>
                </td>
                <td>
                  <button
                    type="button"
                    class="btn secondary"
                    :disabled="busyIds.has(g.id)"
                    @click="handleUnmatch(g.id)"
                  >
                    Отменить сопоставление
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
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
  align-items: center;
  gap: 8px;
}

.source-picker {
  display: flex;
  align-items: center;
  gap: 6px;
}

.source-tag {
  display: inline-block;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  padding: 1px 6px;
  border-radius: 4px;
  margin-right: 6px;
  background: #ede9fe;
  color: #6d28d9;
  vertical-align: middle;
}

.tbank-tag {
  background: #dbeafe;
  color: #1d4ed8;
}

.hint {
  color: #64748b;
  font-size: 13px;
}

.hint.small {
  font-size: 12px;
}

.section {
  margin-bottom: 16px;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}

.section-header h2 {
  margin: 0;
}

.filters {
  display: flex;
  align-items: center;
  gap: 12px;
}

.filters input[type='text'] {
  padding: 6px 10px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  font-size: 13px;
  min-width: 220px;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #475569;
  white-space: nowrap;
}

.section h2 {
  font-size: 16px;
  margin-top: 0;
}

.muted {
  color: #94a3b8;
}

/* Each entry gets its own visually distinct surface (background + left
   accent bar) instead of just a thin bottom border - with 20-100 of these
   in a row, a border alone reads as one continuous blur. Entries that
   actually have a candidate to review (sorted first, see
   filteredUnmatched) get a stronger accent so they stand out from the
   "nothing found nearby" tail. */
.entry-card {
  padding: 12px 14px;
  margin-bottom: 10px;
  background: #f8fafc;
  border-radius: 10px;
  border-left: 3px solid #cbd5e1;
}

.entry-card.has-candidates {
  border-left-color: #6d28d9;
  background: #faf9ff;
}

.entry-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.entry-name {
  font-size: 15px;
}

.entry-status {
  text-align: right;
  font-size: 13px;
}

.no-candidates-note {
  margin: 0;
}

.conflict-note {
  color: #b45309;
}

.badge-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-right: 4px;
}

.candidates {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.candidates li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  flex-wrap: wrap;
}

.candidate-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
}

.entry-actions {
  margin-top: 8px;
}

/* Confirming a match is the primary, common action here - green (distinct
   from the app's default blue .btn, which is already used by "Обновить"
   above) so it doesn't visually compete with every other button on the
   page. "Не станция" is the opposite - a quiet, infrequent dismissal, so
   it gets the .ghost treatment instead of a same-weight secondary button. */
.btn.success {
  background: #16a34a;
  color: #fff;
}

.btn.success:hover {
  background: #15803d;
}

.btn.ghost {
  background: transparent;
  color: #64748b;
  border: 1px solid #e2e8f0;
}

.btn.ghost:hover {
  background: #f1f5f9;
}

.table-wrap {
  overflow-x: auto;
}
</style>
