<script setup>
import { reactive, ref } from 'vue';
import RegionMapPicker from './RegionMapPicker.vue';
import ModalForm from './ModalForm.vue';

const props = defineProps({
  initial: { type: Object, default: null },
});
const emit = defineEmits(['submit', 'cancel']);

const form = reactive({
  name: props.initial?.name || '',
  pollIntervalMinutes: props.initial?.pollIntervalMinutes || 10,
  active: props.initial?.active ?? true,
});

const bbox = reactive({
  minLat: props.initial?.minLat,
  maxLat: props.initial?.maxLat,
  minLon: props.initial?.minLon,
  maxLon: props.initial?.maxLon,
});

const error = ref('');

function onBboxPicked(picked) {
  Object.assign(bbox, picked);
}

function handleSubmit() {
  error.value = '';
  if (!form.name.trim()) {
    error.value = 'Укажите название района';
    return;
  }
  const coords = [bbox.minLat, bbox.maxLat, bbox.minLon, bbox.maxLon];
  if (!coords.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    error.value = 'Задайте границы района на карте или вручную';
    return;
  }
  if (bbox.minLat >= bbox.maxLat || bbox.minLon >= bbox.maxLon) {
    error.value = 'Минимальные координаты должны быть меньше максимальных';
    return;
  }
  emit('submit', {
    name: form.name.trim(),
    pollIntervalMinutes: Number(form.pollIntervalMinutes),
    active: form.active,
    minLat: bbox.minLat,
    maxLat: bbox.maxLat,
    minLon: bbox.minLon,
    maxLon: bbox.maxLon,
  });
}
</script>

<template>
  <ModalForm
    :title="initial ? 'Редактировать район' : 'Новый район'"
    :error="error"
    @submit="handleSubmit"
    @cancel="emit('cancel')"
  >
    <div class="form-row">
      <label for="name">Название</label>
      <input id="name" v-model="form.name" type="text" placeholder="Например, Киров" required />
    </div>

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

    <div class="form-row">
      <label for="interval">Интервал опроса (минут)</label>
      <input id="interval" v-model.number="form.pollIntervalMinutes" type="number" min="1" required />
    </div>

    <div class="form-row form-row--inline">
      <label for="active">
        <input id="active" v-model="form.active" type="checkbox" />
        Активен (опрашивать по расписанию)
      </label>
    </div>
  </ModalForm>
</template>

<style scoped>
.bbox-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 12px;
  margin-top: 12px;
}

.form-row--inline label {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
