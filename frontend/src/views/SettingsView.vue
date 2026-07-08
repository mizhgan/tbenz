<script setup>
import { computed, onMounted, ref } from 'vue';
import { regionsApi } from '../api/regions';
import { useFuelColorsStore } from '../store/fuelColors';
import { fuelTypeLabel, sortFuelTypes } from '../utils/fuelStatus';

const fuelColors = useFuelColorsStore();

const loading = ref(true);
const errorMessage = ref('');
const discoveredTypes = ref([]);
const extraTypes = ref([]);
const newTypeInput = ref('');
const newTypeError = ref('');

// Union of fuel types actually seen in each region's current snapshot,
// anything the user already has a saved color for (so a customization
// doesn't disappear from view just because that fuel type isn't in the
// latest poll), and anything manually added this session.
const allTypes = computed(() =>
  sortFuelTypes(
    Array.from(new Set([...discoveredTypes.value, ...fuelColors.customizedTypes, ...extraTypes.value]))
  )
);

async function loadDiscoveredTypes() {
  loading.value = true;
  errorMessage.value = '';
  try {
    const regions = await regionsApi.list();
    const found = new Set();
    for (const region of regions) {
      try {
        const data = await regionsApi.snapshotAt(region._id);
        for (const station of data.stations) {
          for (const f of station.fuelStatuses || []) found.add(f.fuelType);
        }
      } catch {
        // A single region failing to load its snapshot shouldn't block the
        // others - just means fewer auto-discovered fuel types this time.
      }
    }
    discoveredTypes.value = Array.from(found);
  } catch (err) {
    errorMessage.value = 'Не удалось загрузить список видов топлива из районов';
  } finally {
    loading.value = false;
  }
}

function handleColorInput(fuelType, event) {
  fuelColors.setColor(fuelType, event.target.value);
}

function handleReset(fuelType) {
  fuelColors.resetColor(fuelType);
}

function handleResetAll() {
  if (!confirm('Сбросить цвета всех видов топлива к значениям по умолчанию?')) return;
  fuelColors.resetAll();
}

function handleAddType() {
  newTypeError.value = '';
  const type = newTypeInput.value.trim();
  if (!type) {
    newTypeError.value = 'Укажите вид топлива';
    return;
  }
  if (allTypes.value.includes(type)) {
    newTypeError.value = 'Этот вид топлива уже в списке';
    return;
  }
  extraTypes.value.push(type);
  newTypeInput.value = '';
}

onMounted(loadDiscoveredTypes);
</script>

<template>
  <div>
    <div class="page-header">
      <h1>Настройки — цвета видов топлива</h1>
    </div>

    <p class="hint">
      Цвета применяются к графику истории по видам топлива на карточке станции
      (вкладка «Карта»). Настройки хранятся только в этом браузере
      (localStorage) — у каждого пользователя они свои и не синхронизируются
      между устройствами.
    </p>

    <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>

    <div class="card">
      <p v-if="loading">Загрузка видов топлива...</p>
      <template v-else>
        <p v-if="!allTypes.length" class="hint">
          Пока не удалось найти ни одного вида топлива в данных районов. Можно
          добавить вид топлива вручную ниже.
        </p>
        <table v-else>
          <thead>
            <tr>
              <th>Вид топлива</th>
              <th>Цвет</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="ft in allTypes" :key="ft">
              <td>{{ fuelTypeLabel(ft) }}</td>
              <td>
                <div class="color-cell">
                  <input
                    type="color"
                    :value="fuelColors.colorFor(ft)"
                    @input="handleColorInput(ft, $event)"
                  />
                  <span class="mono">{{ fuelColors.colorFor(ft) }}</span>
                  <span v-if="!fuelColors.isCustom(ft)" class="badge never">по умолчанию</span>
                </div>
              </td>
              <td class="actions">
                <button
                  class="btn secondary"
                  :disabled="!fuelColors.isCustom(ft)"
                  @click="handleReset(ft)"
                >
                  Сбросить
                </button>
              </td>
            </tr>
          </tbody>
        </table>

        <div class="add-type-row">
          <input
            v-model="newTypeInput"
            type="text"
            placeholder="Например, ДТ или 100"
            @keyup.enter="handleAddType"
          />
          <button class="btn secondary" @click="handleAddType">Добавить вид топлива</button>
        </div>
        <p v-if="newTypeError" class="error-text">{{ newTypeError }}</p>

        <div class="reset-all-row">
          <button class="btn danger" :disabled="!fuelColors.customizedTypes.length" @click="handleResetAll">
            Сбросить все цвета к значениям по умолчанию
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.page-header h1 {
  font-size: 20px;
  margin: 0;
}

.hint {
  color: #64748b;
  font-size: 13px;
  max-width: 720px;
  margin-bottom: 16px;
}

.mono {
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 12px;
  color: #445;
}

.color-cell {
  display: flex;
  align-items: center;
  gap: 10px;
}

.color-cell input[type='color'] {
  width: 36px;
  height: 28px;
  padding: 0;
  border: 1px solid #ccd2d9;
  border-radius: 6px;
  cursor: pointer;
}

.actions {
  display: flex;
  gap: 6px;
}

.add-type-row {
  display: flex;
  gap: 8px;
  margin-top: 16px;
  max-width: 420px;
}

.add-type-row input {
  flex: 1;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid #ccd2d9;
}

.reset-all-row {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid #eee;
}
</style>
