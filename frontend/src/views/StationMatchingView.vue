<script setup>
import { onMounted, ref } from 'vue';
import { stationMatchingApi } from '../api/stationMatching';
import { statusMeta, fuelTypeLabel } from '../utils/fuelStatus';

const unmatched = ref([]);
const matched = ref([]);
const loading = ref(true);
const errorMessage = ref('');
const busyIds = ref(new Set());

async function loadAll() {
  loading.value = true;
  errorMessage.value = '';
  try {
    const [unmatchedRes, matchedRes] = await Promise.all([
      stationMatchingApi.listUnmatched(),
      stationMatchingApi.listMatched(),
    ]);
    unmatched.value = unmatchedRes;
    matched.value = matchedRes;
  } catch (err) {
    errorMessage.value = err.response?.data?.error || 'Не удалось загрузить список станций';
  } finally {
    loading.value = false;
  }
}

async function handleMatch(gdebenzId, stationId) {
  busyIds.value.add(gdebenzId);
  errorMessage.value = '';
  try {
    await stationMatchingApi.match(gdebenzId, stationId);
    await loadAll();
  } catch (err) {
    errorMessage.value = err.response?.data?.error || 'Не удалось сопоставить станцию';
  } finally {
    busyIds.value.delete(gdebenzId);
  }
}

async function handleIgnore(gdebenzId) {
  busyIds.value.add(gdebenzId);
  errorMessage.value = '';
  try {
    await stationMatchingApi.ignore(gdebenzId);
    await loadAll();
  } catch (err) {
    errorMessage.value = err.response?.data?.error || 'Не удалось скрыть станцию';
  } finally {
    busyIds.value.delete(gdebenzId);
  }
}

async function handleUnmatch(gdebenzId) {
  if (!confirm('Отменить сопоставление? Объединённые данные останутся в истории, новые опросы перестанут объединяться.')) return;
  busyIds.value.add(gdebenzId);
  errorMessage.value = '';
  try {
    await stationMatchingApi.unmatch(gdebenzId);
    await loadAll();
  } catch (err) {
    errorMessage.value = err.response?.data?.error || 'Не удалось отменить сопоставление';
  } finally {
    busyIds.value.delete(gdebenzId);
  }
}

function fuelTypesLabel(types) {
  return (types || []).map(fuelTypeLabel).join(', ') || '—';
}

onMounted(loadAll);
</script>

<template>
  <div>
    <div class="page-header">
      <h1>Сопоставление станций (gdebenz.ru)</h1>
      <button class="btn secondary" :disabled="loading" @click="loadAll">Обновить</button>
    </div>

    <p class="hint">
      Второй источник данных о наличии топлива (gdebenz.ru) не даёт общего идентификатора со
      станциями tbank, поэтому сопоставление станций делается вручную: для каждой новой станции
      gdebenz ниже показаны ближайшие кандидаты по расстоянию и похожести названия. После
      подтверждения статус этой станции gdebenz дальше объединяется со статусом tbank при каждом
      опросе района — согласие источников даёт подтверждённый статус, а расхождение показывается
      как «возможно доступно», а не выбирается наугад.
    </p>

    <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>
    <p v-if="loading" class="hint">Загрузка...</p>

    <template v-else>
      <div class="card section">
        <h2>Требуют сопоставления ({{ unmatched.length }})</h2>
        <p v-if="!unmatched.length" class="hint">Несопоставленных станций нет.</p>

        <div v-for="g in unmatched" :key="g.id" class="gdebenz-card">
          <div class="gdebenz-header">
            <div>
              <strong>{{ g.name || 'Без названия' }}</strong>
              <span v-if="g.brand && g.brand !== g.name" class="muted"> ({{ g.brand }})</span>
              <div class="hint small">{{ g.address || 'адрес неизвестен' }}</div>
            </div>
            <div class="gdebenz-status">
              <span class="badge-dot" :style="{ background: statusMeta(g.status).color }"></span>
              {{ statusMeta(g.status).label }}
              <span v-if="g.status !== 'not_available'" class="muted"> · {{ fuelTypesLabel(g.fuelTypes) }}</span>
              <div v-if="g.conflict" class="hint small conflict-note">
                у источника есть внутреннее расхождение отчётов: «{{ g.conflict }}»
              </div>
            </div>
          </div>

          <p v-if="!g.suggestions.length" class="hint small">
            Рядом не нашлось ни одной станции tbank — возможно, она не входит ни в один
            отслеживаемый район, или её ещё не видел опрос tbank.
          </p>
          <ul v-else class="candidates">
            <li v-for="s in g.suggestions" :key="s.stationId">
              <div class="candidate-info">
                <strong>{{ s.name || 'АЗС' }}</strong>
                <span class="muted">{{ s.address }}</span>
                <span class="hint small">
                  {{ s.distanceMeters }} м · схожесть названия {{ Math.round(s.nameSimilarity * 100) }}%
                  <template v-if="s.alreadyMatched"> · уже сопоставлена с другой станцией gdebenz</template>
                </span>
              </div>
              <button
                type="button"
                class="btn secondary"
                :disabled="busyIds.has(g.id)"
                @click="handleMatch(g.id, s.stationId)"
              >
                Это та же станция
              </button>
            </li>
          </ul>

          <div class="gdebenz-actions">
            <button type="button" class="btn secondary" :disabled="busyIds.has(g.id)" @click="handleIgnore(g.id)">
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
                <th>gdebenz</th>
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

.section h2 {
  font-size: 16px;
  margin-top: 0;
}

.muted {
  color: #94a3b8;
}

.gdebenz-card {
  padding: 12px 0;
  border-bottom: 1px solid #eee;
}

.gdebenz-card:last-child {
  border-bottom: none;
}

.gdebenz-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.gdebenz-status {
  text-align: right;
  font-size: 13px;
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
  margin: 8px 0;
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
  padding: 8px 10px;
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

.gdebenz-actions {
  margin-top: 8px;
}

.table-wrap {
  overflow-x: auto;
}
</style>
