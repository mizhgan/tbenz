import { ref } from 'vue';
import { statusMeta } from '../utils/fuelStatus';
import { renderMapShareCard, MAP_CONTENT_WIDTH } from '../utils/mapShareCard';
import { canCopyImageToClipboard } from '../utils/stationCard';
import { canShareFile, captureMapBase, lockMapInteraction } from '../utils/mapExport';
import { useAsyncAction } from './useAsyncAction';

/**
 * The "Картинка для шаринга" flow: a single still image of the map exactly
 * as currently shown (base tiles + the same status/brand-filtered markers
 * actually on screen), composed with the region's stat tiles into one
 * shareable PNG. Same generate -> preview -> copy/download/share UI pattern
 * as the station and region report cards (StationDetailModal.vue/
 * ReportsView.vue) - reuses useAsyncAction the same way those do.
 */
export function useMapShareCard({
  mapState,
  stationsRef,
  statusFilters,
  brandFilters,
  effectiveStatus,
  brandOf,
  selectedRegionRef,
  currentSummaryRef,
  badgeFuelLabelRef,
}) {
  const showShareCard = ref(false);
  // Shared across generateShareCard/copyShareCardToClipboard/shareShareCard
  // below - see StationDetailModal.vue's identical grouping/rationale for
  // its own card flow.
  const { loading: shareCardGenerating, error: shareCardError, run: runShareCard } = useAsyncAction();
  const shareCardUrl = ref(null);
  const shareCardCopyFeedback = ref('');
  const shareCardCanShare = ref(false);
  const shareCardClipboardSupported = canCopyImageToClipboard();
  let shareCardBlob = null;
  let shareCardFile = null;

  function resetShareCard() {
    if (shareCardUrl.value) {
      URL.revokeObjectURL(shareCardUrl.value);
      shareCardUrl.value = null;
    }
    shareCardBlob = null;
    shareCardFile = null;
    shareCardCanShare.value = false;
    shareCardCopyFeedback.value = '';
    shareCardError.value = '';
  }

  // Captures the map exactly as currently shown (same base-tile capture the
  // animation export uses, plus the same status/brand-filtered markers
  // actually on screen right now - not the unfiltered currentSummary set,
  // so the picture matches what the user was just looking at) and composes
  // it with currentSummary's stat tiles into one shareable image.
  async function generateShareCard() {
    const map = mapState.map;
    if (!map) return;
    resetShareCard();
    const unlock = lockMapInteraction(map);
    try {
      await runShareCard(
        async () => {
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
          ctx.drawImage(baseCanvas, 0, 0, size.x, size.y);

          // The share card scales this whole canvas down to a fixed content
          // width (see mapShareCard.js) - on a wide desktop window that
          // shrinks a fixed on-screen dot radius into an indistinct smear
          // wherever stations cluster (e.g. a city center). Inflating the
          // radius here by the inverse of that eventual scale keeps the
          // *final* dot size consistent (~8px radius) regardless of how wide
          // the map happened to be captured at.
          const shareCardScale = MAP_CONTENT_WIDTH / size.x;
          const dotRadius = 8 / shareCardScale;
          const dotStroke = 2 / shareCardScale;

          const visibleStations = stationsRef.value.filter(
            (s) => statusFilters[effectiveStatus(s)] !== false && brandFilters[brandOf(s)] !== false
          );
          for (const s of visibleStations) {
            const pt = map.latLngToContainerPoint([s.lat, s.lon]);
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, dotRadius, 0, Math.PI * 2);
            ctx.fillStyle = statusMeta(effectiveStatus(s)).color;
            ctx.fill();
            ctx.lineWidth = dotStroke;
            ctx.strokeStyle = '#ffffff';
            ctx.stroke();
          }

          const blob = await renderMapShareCard({
            regionName: selectedRegionRef.value?.name || 'Район',
            mapCanvas: frameCanvas,
            counts: currentSummaryRef.value.stationCounts,
            stationCount: currentSummaryRef.value.total,
            availablePct: currentSummaryRef.value.availablePct,
            fuelLabel: badgeFuelLabelRef.value,
            generatedAt: Date.now(),
          });
          shareCardBlob = blob;
          shareCardUrl.value = URL.createObjectURL(blob);
          const safeName = (selectedRegionRef.value?.name || 'map').replace(/[^\p{L}\p{N}]+/gu, '-');
          shareCardFile = new File([blob], `${safeName}-map.png`, { type: 'image/png' });
          shareCardCanShare.value = canShareFile(shareCardFile);
        },
        { formatError: (err) => `Не удалось создать картинку: ${err.message || 'неизвестная ошибка'}` }
      );
    } finally {
      unlock();
    }
  }

  function openShareCard() {
    showShareCard.value = true;
    generateShareCard();
  }

  function closeShareCard() {
    showShareCard.value = false;
    resetShareCard();
  }

  async function copyShareCardToClipboard() {
    if (!shareCardBlob) return;
    shareCardCopyFeedback.value = '';
    const result = await runShareCard(() => navigator.clipboard.write([new ClipboardItem({ 'image/png': shareCardBlob })]), {
      formatError: (err) => `Не удалось скопировать: ${err.message || 'неизвестная ошибка'}`,
    });
    shareCardCopyFeedback.value = result !== undefined ? 'ok' : 'error';
  }

  async function shareShareCard() {
    if (!shareCardFile) return;
    await runShareCard(() => navigator.share({ files: [shareCardFile], title: 'Карта доступности топлива' }), {
      formatError: (err) => (err.name === 'AbortError' ? null : `Не удалось поделиться: ${err.message || 'неизвестная ошибка'}`),
    });
  }

  return {
    showShareCard,
    shareCardGenerating,
    shareCardError,
    shareCardUrl,
    shareCardCopyFeedback,
    shareCardCanShare,
    shareCardClipboardSupported,
    generateShareCard,
    openShareCard,
    closeShareCard,
    copyShareCardToClipboard,
    shareShareCard,
  };
}
