import GIF from 'gif.js/dist/gif.js';
import gifWorkerUrl from 'gif.js/dist/gif.worker.js?url';
import leafletImage from 'leaflet-image';

// Renders the map's current tiles/vector layers (but not our own markers -
// callers should remove that layer first) into an offscreen canvas, once.
// Every animation frame then reuses this as its static background.
export function captureMapBase(map) {
  return new Promise((resolve, reject) => {
    leafletImage(map, (err, canvas) => {
      if (err) reject(err);
      else resolve(canvas);
    });
  });
}

export function createGifEncoder({ width, height, quality = 10, workers = 2 }) {
  return new GIF({ workers, quality, width, height, workerScript: gifWorkerUrl });
}

const INTERACTION_HANDLERS = [
  'dragging',
  'scrollWheelZoom',
  'doubleClickZoom',
  'touchZoom',
  'boxZoom',
  'keyboard',
];

// Freezes map pan/zoom while a GIF is being generated so that
// map.latLngToContainerPoint stays consistent with the frozen base image
// captured at the start. Returns a function that restores the prior state.
export function lockMapInteraction(map) {
  const wasEnabled = {};
  for (const name of INTERACTION_HANDLERS) {
    const handler = map[name];
    if (handler && typeof handler.enabled === 'function') {
      wasEnabled[name] = handler.enabled();
      handler.disable();
    }
  }
  return () => {
    for (const name of INTERACTION_HANDLERS) {
      if (wasEnabled[name]) map[name].enable();
    }
  };
}
