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

// video/mp4 recording via MediaRecorder is only broadly supported in Safari;
// Chrome/Firefox/Edge support video/webm. Pick whatever the browser can
// actually produce and let the caller name the file accordingly.
const VIDEO_MIME_CANDIDATES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4',
];

export function pickVideoMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const type of VIDEO_MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Web Share API can hand a file straight to the OS/browser share sheet
// (Telegram included, where the OS integration supports it) - the closest
// thing to "copy and share" that the platform actually offers, since
// browsers do not support writing video to the clipboard at all.
export function canShareFile(file) {
  return typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
}

const INTERACTION_HANDLERS = [
  'dragging',
  'scrollWheelZoom',
  'doubleClickZoom',
  'touchZoom',
  'boxZoom',
  'keyboard',
];

// Freezes map pan/zoom while an export is being generated so that
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
