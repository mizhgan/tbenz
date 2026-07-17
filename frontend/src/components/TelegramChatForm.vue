<script setup>
import { reactive, ref } from 'vue';
import { stationsApi } from '../api/regions';
import RegionMapPicker from './RegionMapPicker.vue';
import { statusMeta } from '../utils/fuelStatus';
import { useAsyncAction } from '../composables/useAsyncAction';

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

// Same 4 statuses/order as MapView.vue's own quick filters.
const MAP_STATUS_KEYS = ['available', 'maybe_available', 'not_available', 'no_data'];

const status = ref(props.initial.status);
const selectedRegionIds = reactive(new Set(props.initial.regions.map((r) => String(r.id))));
const events = reactive({ ...props.initial.events });
const fuelTypesText = ref(props.initial.fuelTypes.join(', '));
const brandsText = ref(props.initial.brands.join(', '));
const watchlist = reactive(
  props.initial.watchlist.map((s) => ({ id: String(s.id), name: s.name, address: s.address }))
);

// Sub-area (deliberately smaller than the region's own, usually much
// larger, bbox) for the map snapshot attached to stationAvailable/
// stationUnavailable alerts - see TelegramChat.js's alertMapBbox doc
// comment for why this isn't just "the whole followed region". All four
// null means "no image" (the default, and what an empty/cleared picker
// submits) - handled the same way RegionForm.vue treats its own bbox,
// just optional here instead of required.
const bbox = reactive({
  minLat: props.initial.alertMapBbox?.minLat ?? null,
  maxLat: props.initial.alertMapBbox?.maxLat ?? null,
  minLon: props.initial.alertMapBbox?.minLon ?? null,
  maxLon: props.initial.alertMapBbox?.maxLon ?? null,
});

function onBboxPicked(picked) {
  Object.assign(bbox, picked);
}

function clearBbox() {
  bbox.minLat = null;
  bbox.maxLat = null;
  bbox.minLon = null;
  bbox.maxLon = null;
}

// Which statuses get a dot on the map image (see TelegramChat.js's own
// doc comment) - defaults to all 4 (i.e. unfiltered) both for a brand new
// chat and for one saved before this field existed, so nothing changes
// until an admin deliberately narrows it. A Set, same pattern as
// selectedRegionIds above.
const selectedMapStatuses = reactive(
  new Set(props.initial.alertMapStatuses?.length ? props.initial.alertMapStatuses : MAP_STATUS_KEYS)
);

function toggleMapStatus(key) {
  if (selectedMapStatuses.has(key)) selectedMapStatuses.delete(key);
  else selectedMapStatuses.add(key);
}

// Once-a-day promotional post at a specific clock time (Europe/Moscow -
// see TelegramChat.js's own doc comment) - reuses this chat's own
// alertMapBbox/alertMapStatuses above for its image instead of a second
// "which area" picker just for this.
const promo = reactive({
  enabled: props.initial.promo?.enabled ?? false,
  time: props.initial.promo?.time || '19:00',
});

const searchQuery = ref('');
const searchResults = ref([]);
const { loading: searching, error: searchError, run: runSearchAction } = useAsyncAction();
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
  const results = await runSearchAction(() => stationsApi.list({ q, limit: 8 }), {
    fallbackMessage: 'Не удалось выполнить поиск',
  });
  if (results) searchResults.value = results;
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
  const bboxValues = [bbox.minLat, bbox.maxLat, bbox.minLon, bbox.maxLon];
  const bboxFilledCount = bboxValues.filter((v) => v !== null && v !== undefined && v !== '').length;
  let alertMapBbox = null;
  if (bboxFilledCount > 0) {
    if (bboxFilledCount < 4 || bboxValues.some((v) => !Number.isFinite(Number(v)))) {
      error.value = 'Для картинки карты в уведомлениях укажите все 4 координаты области (или очистите их все)';
      return;
    }
    const [minLat, maxLat, minLon, maxLon] = bboxValues.map(Number);
    if (minLat >= maxLat || minLon >= maxLon) {
      error.value = 'Область для картинки: минимальные координаты должны быть меньше максимальных';
      return;
    }
    alertMapBbox = { minLat, maxLat, minLon, maxLon };
  }

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
    alertMapBbox,
    alertMapStatuses: MAP_STATUS_KEYS.filter((k) => selectedMapStatuses.has(k)),
    promo: { enabled: promo.enabled, time: promo.time },
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
          <label for="fuelTypes">Виды топлива (через запятую, пусто — АИ-92, АИ-95)</label>
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

        <div class="form-row">
          <label>Картинка карты в уведомлениях о появлении/пропаже топлива</label>
          <p class="hint">
            Необязательно. Выберите на карте область, которую нужно показывать на картинке —
            специально не весь район целиком, чтобы точки станций не были слишком мелкими. Если
            область не задана, уведомления остаются текстовыми, как раньше.
          </p>
          <RegionMapPicker :model-value="bbox" @update:model-value="onBboxPicked" />
          <div class="bbox-grid">
            <div class="form-row">
              <label>minLat</label>
              <input v-model.number="bbox.minLat" type="number" step="any" />
            </div>
            <div class="form-row">
              <label>maxLat</label>
              <input v-model.number="bbox.maxLat" type="number" step="any" />
            </div>
            <div class="form-row">
              <label>minLon</label>
              <input v-model.number="bbox.minLon" type="number" step="any" />
            </div>
            <div class="form-row">
              <label>maxLon</label>
              <input v-model.number="bbox.maxLon" type="number" step="any" />
            </div>
          </div>
          <button type="button" class="btn secondary" @click="clearBbox">Убрать картинку (не задавать область)</button>

          <p class="hint" style="margin-top: 12px">
            Какие статусы отмечать точками на картинке — например, можно убрать «Нет», если
            станций без топлива слишком много и они перекрывают всё остальное. На сводку чисел под
            картинкой это не влияет — там всегда полная картина (по АИ-92, АИ-95, без учёта этого
            фильтра).
          </p>
          <div class="region-list">
            <label v-for="key in MAP_STATUS_KEYS" :key="key" class="filter-checkbox">
              <input
                type="checkbox"
                :checked="selectedMapStatuses.has(key)"
                @change="toggleMapStatus(key)"
              />
              <span class="status-dot" :style="{ background: statusMeta(key).color }"></span>
              {{ statusMeta(key).label }}
            </label>
          </div>
        </div>

        <div class="form-row">
          <label>Ежедневный пост-приглашение</label>
          <p class="hint">
            Раз в день в выбранное время публикует пост со ссылками на сайт и бота (текст каждый
            раз немного разный, суть та же). Картинка берётся из настройки выше (область на карте)
            — если она не задана, пост уходит только текстом. Для привлечения новых подписчиков,
            не для оповещений о статусе топлива.
          </p>
          <label class="filter-checkbox">
            <input type="checkbox" v-model="promo.enabled" />
            Публиковать ежедневный пост
          </label>
          <div class="form-row">
            <label for="promoTime">Время (по Москве)</label>
            <input id="promoTime" v-model="promo.time" type="time" />
          </div>
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

.bbox-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 12px;
  margin-top: 12px;
}

.filter-checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: normal;
}

.status-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
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

/* Site dark theme (store/theme.js) - this file's own .region-list/list-item
   borders otherwise tie in specificity with main.css's generic dark rule
   and can win on source order alone. */
[data-theme='dark'] .region-list,
[data-theme='dark'] .search-results li,
[data-theme='dark'] .watchlist-items li {
  border-color: #334155;
}
</style>
