<script setup>
import { computed, onMounted, ref } from 'vue';
import { regionsApi } from '../api/regions';
import { useFuelColorsStore } from '../store/fuelColors';
import { fuelTypeLabel, sortFuelTypes } from '../utils/fuelStatus';

const fuelColors = useFuelColorsStore();

const loading = ref(true);
const errorMessage = ref('');
const discoveredTypes = ref([]);

// Union of fuel types actually seen in each region's current snapshot and
// anything the user already has a saved color for (so a customization
// doesn't disappear from view just because that fuel type isn't in the
// latest poll) - no way to manually add an arbitrary type on top of that:
// these colors only ever apply to fuel types that actually show up
// somewhere, so adding one with nothing to color would do nothing.
const allTypes = computed(() =>
  sortFuelTypes(Array.from(new Set([...discoveredTypes.value, ...fuelColors.customizedTypes])))
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
          Пока не удалось найти ни одного вида топлива в данных районов.
        </p>
        <div v-else class="table-scroll">
          <table>
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
        </div>

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

/* The color swatch + hex code + badge + "Сбросить" button don't shrink
   below their natural width - on a narrow phone the table ends up wider
   than the screen. Scrolling it inside this wrapper keeps that overflow
   contained instead of pushing the whole page (including the topbar)
   sideways. */
.table-scroll {
  overflow-x: auto;
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

.reset-all-row {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid #eee;
}

/* Site dark theme (store/theme.js) - this file's own .hint/.mono colors and
   the reset-row divider otherwise tie in specificity with main.css's
   generic dark rule and can win on source order alone. */
[data-theme='dark'] .hint,
[data-theme='dark'] .mono {
  color: #94a3b8;
}

[data-theme='dark'] .color-cell input[type='color'] {
  border-color: #334155;
}

[data-theme='dark'] .reset-all-row {
  border-top-color: #334155;
}
</style>
