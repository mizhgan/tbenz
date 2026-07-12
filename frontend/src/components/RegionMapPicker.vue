<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import L from 'leaflet';

const props = defineProps({
  modelValue: { type: Object, default: null },
});
const emit = defineEmits(['update:modelValue']);

const mapContainer = ref(null);
let map = null;
let rectangleLayer = null;
let previewLayer = null;
let pendingCorner = null;

const DEFAULT_CENTER = [55.75, 37.62];
const DEFAULT_ZOOM = 9;

function isValidBbox(b) {
  return (
    b &&
    ['minLat', 'maxLat', 'minLon', 'maxLon'].every(
      (key) => typeof b[key] === 'number' && Number.isFinite(b[key])
    )
  );
}

function toLatLngBounds(b) {
  return [
    [b.minLat, b.minLon],
    [b.maxLat, b.maxLon],
  ];
}

function boundsFromCorners(a, b) {
  return {
    minLat: Math.min(a.lat, b.lat),
    maxLat: Math.max(a.lat, b.lat),
    minLon: Math.min(a.lng, b.lng),
    maxLon: Math.max(a.lng, b.lng),
  };
}

function drawRectangle(bbox) {
  if (rectangleLayer) {
    map.removeLayer(rectangleLayer);
    rectangleLayer = null;
  }
  rectangleLayer = L.rectangle(toLatLngBounds(bbox), {
    color: '#2563eb',
    weight: 2,
    fillOpacity: 0.1,
  }).addTo(map);
}

function clearPreview() {
  if (previewLayer) {
    map.removeLayer(previewLayer);
    previewLayer = null;
  }
}

function handleMapClick(e) {
  if (!pendingCorner) {
    pendingCorner = e.latlng;
    return;
  }
  const bbox = boundsFromCorners(pendingCorner, e.latlng);
  pendingCorner = null;
  clearPreview();
  drawRectangle(bbox);
  emit('update:modelValue', bbox);
}

function handleMouseMove(e) {
  if (!pendingCorner) return;
  clearPreview();
  const bbox = boundsFromCorners(pendingCorner, e.latlng);
  previewLayer = L.rectangle(toLatLngBounds(bbox), {
    color: '#2563eb',
    weight: 1,
    dashArray: '4',
    fillOpacity: 0.05,
  }).addTo(map);
}

onMounted(() => {
  map = L.map(mapContainer.value).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
  // Leaflet's own "Leaflet" link in the attribution control is just its
  // default branding, not a license requirement - drop it, same as
  // MapView.vue/StationDetailModal.vue/StationSourcesModal.vue already do.
  // The OpenStreetMap attribution added by the tile layer below stays:
  // it's required by OSM's tile usage policy for their free tiles.
  map.attributionControl.setPrefix(false);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(map);
  map.on('click', handleMapClick);
  map.on('mousemove', handleMouseMove);

  if (isValidBbox(props.modelValue)) {
    drawRectangle(props.modelValue);
    map.fitBounds(toLatLngBounds(props.modelValue), { padding: [20, 20] });
  }
});

onBeforeUnmount(() => {
  if (map) map.remove();
});

watch(
  () => props.modelValue,
  (bbox) => {
    if (map && isValidBbox(bbox)) {
      drawRectangle(bbox);
    }
  },
  { deep: true }
);
</script>

<template>
  <div>
    <div ref="mapContainer" class="picker-map"></div>
    <p class="hint">
      Кликните по карте дважды, чтобы задать противоположные углы прямоугольника района, либо
      введите координаты вручную ниже.
    </p>
  </div>
</template>

<style scoped>
.picker-map {
  height: 320px;
  border-radius: 8px;
  overflow: hidden;
}

.hint {
  font-size: 12px;
  color: #667;
  margin-top: 6px;
}
</style>
