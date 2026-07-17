import { onBeforeUnmount, ref } from 'vue';
import { regionsApi } from '../api/regions';
import { statusMeta } from '../utils/fuelStatus';
import {
  canShareFile,
  captureMapBase,
  createGifEncoder,
  downsampleEvenly,
  lockMapInteraction,
  pickVideoMimeType,
  sleep,
} from '../utils/mapExport';

function formatDateTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('ru-RU');
}

/**
 * The "Экспорт анимации" panel: fetches a range of historical snapshots and
 * encodes them into a GIF or video of the map with markers animating
 * through time. Independent of useMapShareCard (a single still image) even
 * though both capture the same base map tiles - this one needs a from/to
 * range and a multi-frame encode loop, that one doesn't.
 *
 * Kept separate from useMapMarkers on purpose: this needs `map`/
 * `markersLayer` only to grab a frozen base-tile snapshot and to convert
 * lat/lon to on-screen pixels for its own hand-drawn canvas dots, not to
 * touch the live marker layer or its popups at all.
 */
export function useMapExport({ mapState, selectedRegionId, range, statusFilters, brandFilters, effectiveStatus, brandOf }) {
  const showExportPanel = ref(false);
  const exportGenerating = ref(false);
  const exportFetchProgress = ref(0);
  const exportEncodeProgress = ref(0);
  const exportResultUrl = ref(null);
  const exportResultMimeType = ref('');
  const exportError = ref('');
  const exportCanShare = ref(false);
  const exportFrameInfo = ref('');
  const videoExportSupported = ref(!!pickVideoMimeType());
  let exportResultFile = null;

  onBeforeUnmount(() => {
    if (exportResultUrl.value) URL.revokeObjectURL(exportResultUrl.value);
  });

  function openExportPanel() {
    if (range.value.from === null || range.value.to === null) return;
    exportError.value = '';
    showExportPanel.value = true;
  }

  function resetExportResult() {
    if (exportResultUrl.value) {
      URL.revokeObjectURL(exportResultUrl.value);
      exportResultUrl.value = null;
    }
    exportResultMimeType.value = '';
    exportResultFile = null;
    exportCanShare.value = false;
    exportFrameInfo.value = '';
    exportError.value = '';
  }

  function closeExportPanel() {
    showExportPanel.value = false;
    resetExportResult();
  }

  async function handleShareExport() {
    if (!exportResultFile) return;
    try {
      await navigator.share({
        files: [exportResultFile],
        title: 'Статусы доступности топлива',
      });
    } catch (err) {
      if (err.name !== 'AbortError') {
        exportError.value = `Не удалось поделиться: ${err.message || 'неизвестная ошибка'}`;
      }
    }
  }

  async function handleGenerateExport({ fromMs, toMs, maxFrames, frameDelayMs, format }) {
    const map = mapState.map;
    if (!map || !selectedRegionId.value) return;

    resetExportResult();
    exportGenerating.value = true;
    exportFetchProgress.value = 0;
    exportEncodeProgress.value = 0;

    const unlock = lockMapInteraction(map);
    try {
      const { times } = await regionsApi.snapshotTimes(selectedRegionId.value, {
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
      });
      if (!times.length) {
        throw new Error('В выбранном диапазоне нет сохранённых снимков');
      }
      const allTimestamps = times.map((t) => new Date(t).getTime()).sort((a, b) => a - b);
      const timestamps = downsampleEvenly(allTimestamps, maxFrames);
      exportFrameInfo.value =
        timestamps.length < allTimestamps.length
          ? `Найдено снимков: ${allTimestamps.length}, использовано (равномерно прорежено): ${timestamps.length}`
          : `Использовано снимков: ${timestamps.length}`;

      const size = map.getSize();

      mapState.markersLayer.remove();
      let baseCanvas;
      try {
        baseCanvas = await captureMapBase(map);
      } finally {
        mapState.markersLayer.addTo(map);
      }

      const frameCanvas = document.createElement('canvas');
      frameCanvas.width = size.x;
      frameCanvas.height = size.y;
      const ctx = frameCanvas.getContext('2d');

      // Fetches one moment's station snapshot and paints it (dots +
      // timestamp label) over the frozen base map image already on `ctx`.
      async function drawFrame(ts) {
        const data = await regionsApi.snapshotAt(selectedRegionId.value, new Date(ts).toISOString());
        const frameStations = data.stations.filter(
          (s) => statusFilters[effectiveStatus(s)] !== false && brandFilters[brandOf(s)] !== false
        );

        ctx.drawImage(baseCanvas, 0, 0, size.x, size.y);
        for (const s of frameStations) {
          const pt = map.latLngToContainerPoint([s.lat, s.lon]);
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 6, 0, Math.PI * 2);
          ctx.fillStyle = statusMeta(effectiveStatus(s)).color;
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = '#ffffff';
          ctx.stroke();
        }

        const label = formatDateTime(ts);
        ctx.font = '13px sans-serif';
        const textWidth = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
        ctx.fillRect(8, 8, textWidth + 16, 24);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(label, 16, 25);
      }

      let blob;
      let mimeType;

      if (format === 'video') {
        mimeType = pickVideoMimeType();
        if (!mimeType) throw new Error('Браузер не поддерживает запись видео');

        const stream = frameCanvas.captureStream(0);
        const track = stream.getVideoTracks()[0];
        const recorder = new MediaRecorder(stream, { mimeType });
        const chunks = [];
        recorder.ondataavailable = (e) => {
          if (e.data.size) chunks.push(e.data);
        };
        const stopped = new Promise((resolve) => {
          recorder.onstop = resolve;
        });

        recorder.start();
        for (let i = 0; i < timestamps.length; i++) {
          await drawFrame(timestamps[i]);
          track.requestFrame();
          const progress = Math.round(((i + 1) / timestamps.length) * 100);
          exportFetchProgress.value = progress;
          exportEncodeProgress.value = progress;
          await sleep(frameDelayMs);
        }
        recorder.stop();
        await stopped;
        blob = new Blob(chunks, { type: mimeType });
      } else {
        mimeType = 'image/gif';
        const encoder = createGifEncoder({ width: size.x, height: size.y });
        encoder.on('progress', (ratio) => {
          exportEncodeProgress.value = Math.round(ratio * 100);
        });

        for (let i = 0; i < timestamps.length; i++) {
          await drawFrame(timestamps[i]);
          encoder.addFrame(ctx, { copy: true, delay: frameDelayMs });
          exportFetchProgress.value = Math.round(((i + 1) / timestamps.length) * 100);
        }

        blob = await new Promise((resolve, reject) => {
          encoder.on('finished', resolve);
          encoder.on('abort', () => reject(new Error('Генерация прервана')));
          encoder.render();
        });
      }

      exportResultUrl.value = URL.createObjectURL(blob);
      exportResultMimeType.value = mimeType;
      const extension = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('webm') ? 'webm' : 'gif';
      exportResultFile = new File([blob], `fuel-status.${extension}`, { type: mimeType });
      exportCanShare.value = canShareFile(exportResultFile);
    } catch (err) {
      exportError.value = `Не удалось создать экспорт: ${err.message || 'неизвестная ошибка'}`;
    } finally {
      exportGenerating.value = false;
      unlock();
    }
  }

  return {
    showExportPanel,
    exportGenerating,
    exportFetchProgress,
    exportEncodeProgress,
    exportResultUrl,
    exportResultMimeType,
    exportError,
    exportCanShare,
    exportFrameInfo,
    videoExportSupported,
    openExportPanel,
    resetExportResult,
    closeExportPanel,
    handleShareExport,
    handleGenerateExport,
  };
}
