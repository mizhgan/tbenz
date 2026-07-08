<script setup>
import { reactive, ref } from 'vue';
import { stationsApi } from '../api/regions';

const props = defineProps({
  initial: { type: Object, required: true },
  regions: { type: Array, default: () => [] },
});
const emit = defineEmits(['submit', 'cancel']);

const STATUS_OPTIONS = [
  { value: 'pending', label: 'Ожидает настройки' },
  { value: 'active', label: 'Активен (получает уведомления)' },
  { value: 'disabled', label: 'Отключён' },
];

const EVENT_OPTIONS = [
  { key: 'stationAvailable', label: 'Топливо появилось на станции' },
  { key: 'stationUnavailable', label: 'Топливо пропало на станции' },
  { key: 'hourlyDigest', label: 'Часовая сводка по районам' },
  { key: 'dailyDigest', label: 'Дневная сводка по районам' },
  { key: 'predictiveDropAlert', label: 'Прогноз: скоро может пропасть' },
  { key: 'predictiveRecoveryAlert', label: 'Прогноз: скоро может появиться' },
];

const status = ref(props.initial.status);
const selectedRegionIds = reactive(new Set(props.initial.regions.map((r) => String(r.id))));
const events = reactive({ ...props.initial.events });
const fuelTypesText = ref(props.initial.fuelTypes.join(', '));
const brandsText = ref(props.initial.brands.join(', '));
const watchlist = reactive(
  props.initial.watchlist.map((s) => ({ id: String(s.id), name: s.name, address: s.address }))
);

const searchQuery = ref('');
const searchResults = ref([]);
const searching = ref(false);
const searchError = ref('');
const error = ref('');

function toggleRegion(id) {
  const key = String(id);
  if (selectedRegionIds.has(key)) selectedRegionIds.delete(key);
  else selectedRegionIds.add(key);
}

async function runSearch() {
  const q = searchQuery.value.trim();
  if (!q) {
    searchResults.value = [];
    return;
  }
  searching.value = true;
  searchError.value = '';
  try {
    searchResults.value = await stationsApi.list({ q, limit: 8 });
  } catch (err) {
    searchError.value = err.response?.data?.error || 'Не удалось выполнить поиск';
  } finally {
    searching.value = false;
  }
}

function addStation(station) {
  const id = String(station._id || station.id);
  if (watchlist.some((s) => s.id === id)) return;
  watchlist.push({ id, name: station.name, address: station.address });
}

function removeStation(id) {
  const idx = watchlist.findIndex((s) => s.id === id);
  if (idx !== -1) watchlist.splice(idx, 1);
}

function handleSubmit() {
  error.value = '';
  const payload = {
    status: status.value,
    regions: Array.from(selectedRegionIds),
    events: { ...events },
    fuelTypes: fuelTypesText.value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    brands: brandsText.value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    watchlist: watchlist.map((s) => s.id),
  };
  emit('submit', payload);
}
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop" @click.self="emit('cancel')">
      <form class="card modal-card" @submit.prevent="handleSubmit">
        <h2>Настройка чата «{{ initial.title || initial.chatId }}»</h2>
        <p class="hint">
          {{ initial.type }} · ID {{ initial.chatId }}
        </p>

        <div class="form-row">
          <label for="status">Статус</label>
          <select id="status" v-model="status">
            <option v-for="opt in STATUS_OPTIONS" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
        </div>

        <div class="form-row">
          <label>Районы, за которыми следит чат</label>
          <div class="region-list">
            <p v-if="!regions.length" class="muted">Районы ещё не созданы.</p>
            <label v-for="r in regions" :key="r._id" class="filter-checkbox">
              <input
                type="checkbox"
                :checked="selectedRegionIds.has(String(r._id))"
                @change="toggleRegion(r._id)"
              />
              {{ r.name }}
            </label>
          </div>
        </div>

        <div class="form-row">
          <label>События</label>
          <div class="region-list">
            <label v-for="opt in EVENT_OPTIONS" :key="opt.key" class="filter-checkbox">
              <input type="checkbox" v-model="events[opt.key]" />
              {{ opt.label }}
            </label>
          </div>
        </div>

        <div class="form-row">
          <label for="fuelTypes">Виды топлива (через запятую, пусто — все)</label>
          <input id="fuelTypes" v-model="fuelTypesText" type="text" placeholder="92, 95, 98" />
        </div>

        <div class="form-row">
          <label for="brands">Сети АЗС (через запятую, пусто — все)</label>
          <input id="brands" v-model="brandsText" type="text" placeholder="Роснефть, Лукойл" />
        </div>

        <div class="form-row">
          <label>Вотчлист станций</label>
          <p class="hint">Станции из вотчлиста уведомляют чат независимо от фильтров выше.</p>
          <div class="watchlist-search">
            <input
              v-model="searchQuery"
              type="text"
              placeholder="Поиск станции по названию или адресу"
              @keyup.enter.prevent="runSearch"
            />
            <button type="button" class="btn secondary" :disabled="searching" @click="runSearch">
              {{ searching ? 'Поиск...' : 'Найти' }}
            </button>
          </div>
          <p v-if="searchError" class="error-text">{{ searchError }}</p>
          <ul v-if="searchResults.length" class="search-results">
            <li v-for="s in searchResults" :key="s._id">
              <span>{{ s.name }} <span class="muted">{{ s.address }}</span></span>
              <button type="button" class="btn secondary" @click="addStation(s)">Добавить</button>
            </li>
          </ul>

          <ul v-if="watchlist.length" class="watchlist-items">
            <li v-for="s in watchlist" :key="s.id">
              <span>{{ s.name || s.id }} <span class="muted">{{ s.address }}</span></span>
              <button type="button" class="btn danger" @click="removeStation(s.id)">Убрать</button>
            </li>
          </ul>
          <p v-else class="muted">Вотчлист пуст.</p>
        </div>

        <p v-if="error" class="error-text">{{ error }}</p>

        <div class="modal-actions">
          <button type="button" class="btn secondary" @click="emit('cancel')">Отмена</button>
          <button type="submit" class="btn">Сохранить</button>
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
  margin-bottom: 2px;
  font-size: 18px;
}

.region-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 160px;
  overflow-y: auto;
  padding: 8px 10px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
}

.filter-checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: normal;
}

.muted {
  color: #94a3b8;
  font-size: 12px;
}

.watchlist-search {
  display: flex;
  gap: 8px;
}

.watchlist-search input {
  flex: 1;
}

.search-results,
.watchlist-items {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.search-results li,
.watchlist-items li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  font-size: 13px;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 16px;
}
</style>
