import { computed, ref } from 'vue';
import { stationsApi } from '../api/regions';
import { computeStatusSegments, collapseIsolatedBlips } from '../utils/fuelStatus';
import { renderRegionReportCard } from '../utils/regionReportCard';
import { canCopyImageToClipboard } from '../utils/stationCard';
import { canShareFile } from '../utils/mapExport';
import { useAsyncAction } from './useAsyncAction';

/**
 * The "Картинка отчёта для шаринга" flow: a client-side canvas render of the
 * selected period's KPIs/charts/top stations into one shareable PNG - same
 * generate -> preview -> copy/download/share UI pattern as the station card
 * (StationDetailModal.vue) and the map's own share card (useMapShareCard.js).
 *
 * Every param here is a ref/computed owned by another composable
 * (useReportPeriod.js's fromMs/toMs/fromIso/toIso, useReportMetrics.js's
 * selectedRegion/trendBuckets/forecastBuckets/recoveryTrendBuckets/
 * forecastDirection, useReportSummary.js's summary) or by ReportsView.vue
 * itself (highlightedStations/stationsSort, the "лучшие/худшие" toggle) -
 * read live via .value when generateReportCard actually runs, not captured
 * once at construction.
 */
export function useReportCard({
  selectedRegion,
  fromMs,
  toMs,
  fromIso,
  toIso,
  summary,
  trendBuckets,
  forecastBuckets,
  recoveryTrendBuckets,
  forecastDirection,
  highlightedStations,
  stationsSort,
}) {
  const cardUrl = ref(null);
  const copyFeedback = ref('');
  // Shared across generateReportCard/copyReportCardToClipboard/shareReportCard
  // below - see StationDetailModal.vue's identical grouping/rationale for
  // its own card flow.
  const { loading: cardGenerating, error: cardError, run: runCard } = useAsyncAction();
  const clipboardSupported = canCopyImageToClipboard();
  let cardBlob = null;
  let cardFile = null;
  const canShareCard = computed(() => !!cardFile && canShareFile(cardFile));

  function resetReportCard() {
    if (cardUrl.value) {
      URL.revokeObjectURL(cardUrl.value);
      cardUrl.value = null;
    }
    cardBlob = null;
    cardFile = null;
    cardError.value = '';
    copyFeedback.value = '';
  }

  async function generateReportCard() {
    copyFeedback.value = '';
    await runCard(
      async () => {
        const topStationsBase = highlightedStations.value.slice(0, 3);
        // Best-of (default CORE_FUEL_TYPES) ribbon per top station, same real
        // segments (not bucketed) StationReliabilityTimeline.vue itself draws -
        // fetched here rather than inside regionReportCard.js since that file
        // is a pure Canvas layout function with no API access of its own (same
        // pattern generateCard() in StationDetailModal.vue already follows for
        // its own card's history). Only 3 stations, so 3 parallel fetches.
        const historyResults = await Promise.allSettled(
          topStationsBase.map((s) => stationsApi.history(s.stationId, { from: fromIso.value, to: toIso.value, limit: 5000 }))
        );
        const topStations = topStationsBase.map((s, i) => {
          const result = historyResults[i];
          const history = result.status === 'fulfilled' ? result.value : [];
          const ribbon = history.length ? collapseIsolatedBlips(computeStatusSegments(history)) : [];
          return {
            ...s,
            ribbon,
            ribbonRangeStart: history.length ? history[0].polledAt : null,
            ribbonRangeEnd: history.length ? history[history.length - 1].polledAt : null,
          };
        });

        const blob = await renderRegionReportCard({
          region: selectedRegion.value || { name: 'Район' },
          from: fromMs.value,
          to: toMs.value,
          summary: summary.value,
          trendBuckets: trendBuckets.value,
          forecastBuckets: forecastBuckets.value,
          recoveryTrendBuckets: recoveryTrendBuckets.value,
          direction: forecastDirection.value,
          topStations,
          stationsLabel: stationsSort.value === 'best' ? 'Лучшие станции' : 'Худшие станции',
        });
        if (cardUrl.value) URL.revokeObjectURL(cardUrl.value);
        cardBlob = blob;
        cardUrl.value = URL.createObjectURL(blob);
        const safeName = (selectedRegion.value?.name || 'region').replace(/[^\p{L}\p{N}]+/gu, '-');
        cardFile = new File([blob], `${safeName}-report.png`, { type: 'image/png' });
      },
      { formatError: (err) => `Не удалось создать картинку: ${err.message || 'неизвестная ошибка'}` }
    );
  }

  async function copyReportCardToClipboard() {
    if (!cardBlob) return;
    copyFeedback.value = '';
    const result = await runCard(() => navigator.clipboard.write([new ClipboardItem({ 'image/png': cardBlob })]), {
      formatError: (err) => `Не удалось скопировать: ${err.message || 'неизвестная ошибка'}`,
    });
    copyFeedback.value = result !== undefined ? 'ok' : 'error';
  }

  async function shareReportCard() {
    if (!cardFile) return;
    await runCard(() => navigator.share({ files: [cardFile], title: `Отчёт: ${selectedRegion.value?.name || 'Район'}` }), {
      formatError: (err) => (err.name === 'AbortError' ? null : `Не удалось поделиться: ${err.message || 'неизвестная ошибка'}`),
    });
  }

  return {
    cardUrl,
    copyFeedback,
    cardGenerating,
    cardError,
    clipboardSupported,
    canShareCard,
    resetReportCard,
    generateReportCard,
    copyReportCardToClipboard,
    shareReportCard,
  };
}
