import { computed, ref } from 'vue';

function msToLocalInputValue(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Hourly threshold raised from 48h to 7 days (the "7д" preset's own span) -
// 168 hourly points is still nothing for Chart.js to auto-thin (same as the
// daily threshold below, already tuned for a far bigger 90 daily points).
// Daily threshold raised from 14 to 90 days - at 14, a 30-day report (the
// widest preset button) fell into weekly buckets and rendered as ~5 points,
// most of the "Динамика доступности" chart empty past that. No need for a
// fancier adaptive scheme than these two thresholds - just moving each cliff
// somewhere the still-fixed 24ч/7д/30д/90д preset buttons don't land right
// on top of it.
function pickBucketHours(spanMs) {
  const spanHours = spanMs / 3600000;
  if (spanHours <= 24 * 7) return 1;
  if (spanHours <= 24 * 90) return 24;
  return 24 * 7;
}

const PRESET_HOURS = [24, 24 * 7, 24 * 30, 24 * 90];

/**
 * The selected date range (from/to, plus the immediately-preceding period of
 * the same length for the KPI cards' own delta) and the bucket size derived
 * from it - the "what period is being reported on" half of the reports
 * page, independent of what's actually loaded for it (useReportMetrics.js,
 * which reads fromIso/toIso/bucketHours from here) or how it's summarized
 * (useReportSummary.js).
 *
 * `onChange` fires after every user-driven range change (a preset click or a
 * manual datetime-local edit) - the caller decides what that should trigger
 * (ReportsView.vue passes its own loadMetrics), since re-fetching isn't this
 * composable's concern.
 */
export function useReportPeriod({ onChange }) {
  const now = Date.now();
  const fromMs = ref(now - 7 * 24 * 60 * 60 * 1000);
  const toMs = ref(now);
  // Exposed as their own computed properties (not just local vars inside
  // loadMetrics) so the template can pass the page's actual selected period
  // down to StationHighlightCards' ribbons too - those used to always show a
  // fixed last-7-days regardless of what period was picked here.
  const fromIso = computed(() => new Date(fromMs.value).toISOString());
  const toIso = computed(() => new Date(toMs.value).toISOString());
  // The period immediately preceding the selected one, same length - lets the
  // KPI cards show "+3% vs previous period" instead of a bare number with no
  // sense of whether that's an improvement. Same length both sides so the
  // comparison is apples-to-apples (a 90-day count of outages is naturally
  // bigger than a 7-day one regardless of any real trend).
  const prevFromIso = computed(() => new Date(2 * fromMs.value - toMs.value).toISOString());
  const prevToIso = computed(() => fromIso.value);
  // Single source of truth for the period's chosen bucket size - loadMetrics
  // uses it for every bucketed API call, AvailabilityRecoveryChart.vue's own
  // recovery-trend tooltip and hint text use it to phrase "за день"/"за
  // неделю" instead of guessing independently (see bucketPeriodLabel's own
  // doc comment).
  const bucketHours = computed(() => pickBucketHours(toMs.value - fromMs.value));

  // A native <input type="datetime-local"> renders its own displayed text in
  // whatever format the visitor's OS locale gives Chromium - confirmed live,
  // that's US-style "MM/DD/YYYY, hh:mm AM/PM" even with the page (and even an
  // explicit Playwright browser-context locale) set to ru-RU, since it's tied
  // to the OS itself, something this app has no way to override. On a
  // Russian-language page that reads as ambiguous at best ("09/05" - which is
  // the month?) - this plain-text echo underneath is always formatted the
  // same way regardless of the visitor's own OS, so there's at least one
  // unambiguous confirmation of what's actually selected.
  function formatRuDateTime(ms) {
    return new Date(ms).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  const fromInput = computed({
    get: () => msToLocalInputValue(fromMs.value),
    set: (v) => {
      const parsed = new Date(v).getTime();
      if (Number.isFinite(parsed)) {
        fromMs.value = parsed;
        onChange();
      }
    },
  });
  const toInput = computed({
    get: () => msToLocalInputValue(toMs.value),
    set: (v) => {
      const parsed = new Date(v).getTime();
      if (Number.isFinite(parsed)) {
        toMs.value = parsed;
        onChange();
      }
    },
  });

  function setPreset(hours) {
    toMs.value = Date.now();
    fromMs.value = toMs.value - hours * 60 * 60 * 1000;
    onChange();
  }

  // Reported live: with all four preset buttons always the same gray, there
  // was no way to tell at a glance whether "24ч"/"7д"/"30д"/"90д" (or none of
  // them - a manually-typed custom range) was actually the period currently
  // shown below. Compares the *selected span*, not just from/to against
  // "now" - the datetime-local inputs stay editable/pickable independently of
  // these buttons, so an active button reflects "this is a preset-sized
  // range" rather than tracking which control was last touched. A small
  // tolerance (not exact equality) covers datetime-local's own minute-only
  // precision: typing exactly one of these spans in by hand still lights up
  // the matching button instead of silently falling through to "custom".
  const activePresetHours = computed(() => {
    const spanHours = (toMs.value - fromMs.value) / 3600000;
    return PRESET_HOURS.find((h) => Math.abs(spanHours - h) < 1 / 30) ?? null; // ~2 min tolerance
  });

  return {
    fromMs,
    toMs,
    fromIso,
    toIso,
    prevFromIso,
    prevToIso,
    bucketHours,
    fromInput,
    toInput,
    activePresetHours,
    setPreset,
    formatRuDateTime,
  };
}
