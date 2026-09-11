import { availabilityColor, formatPct, formatMinutes } from './colorScale';
import { statusMeta } from './fuelStatus';
import { roundRect, wrapText, renderCard } from './canvasDraw';

const WIDTH = 1000;
const PADDING = 56;
const FOOTER_HEIGHT = 80;

const DIRECTION_META = {
  improving: { label: 'Улучшается', icon: '↗', color: '#16a34a' },
  worsening: { label: 'Ухудшается', icon: '↘', color: '#dc2626' },
  stable: { label: 'Стабильно', icon: '→', color: '#6b7280' },
  unknown: { label: 'Недостаточно данных', icon: '', color: '#6b7280' },
};

// Based on actual calendar-day boundaries, not a span-length threshold - a
// span-based heuristic (e.g. "show only time if under 36h") breaks for an
// exactly-24h period: from/to land on the same time-of-day on different
// dates, so a time-only label like "18:15–18:15" looks identical even
// though the dates differ by a full day. Checking real dates instead of
// guessing from duration fixes that regardless of how long the period is.
function formatDateRange(from, to) {
  const fromD = new Date(from);
  const toD = new Date(to);
  const dateFmt = (d) => d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  const timeFmt = (d) => d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const sameDay = fromD.toDateString() === toD.toDateString();
  if (sameDay) {
    return `${dateFmt(fromD)} ${timeFmt(fromD)}–${timeFmt(toD)}`;
  }
  return `${dateFmt(fromD)} ${timeFmt(fromD)} – ${dateFmt(toD)} ${timeFmt(toD)}`;
}

// Change from the first to the last bucket that actually has data - "how
// did it move over the period", not a statistically fitted trend (that's
// what the dashed forecast line on the page itself is for).
function computeTrendDelta(buckets) {
  const known = (buckets || []).filter((b) => b.availablePct !== null && b.availablePct !== undefined);
  if (known.length < 2) return null;
  return known[known.length - 1].availablePct - known[0].availablePct;
}

// Same status colors as TrendChart.vue (the full chart on the reports
// page), so the compact card reads as "the same chart, smaller" rather
// than introducing its own unrelated color language.
const STATUS_COLORS = {
  available: '#16a34a',
  maybe_available: '#d97706',
  not_available: '#dc2626',
};
const FORECAST_COLOR = '#2563eb';

// Carries the nearest known value forward (then back-fills any leading
// gap) instead of leaving a hole - a simple stand-in for Chart.js's
// spanGaps:true, which is what TrendChart.vue itself uses for the exact
// same buckets. Deliberately bridges gaps rather than breaking the line
// there (unlike the Telegram digest sparkline), to match what the on-page
// chart already does with this same data.
function fillGaps(values) {
  const out = values.slice();
  for (let i = 1; i < out.length; i++) {
    if (out[i] === null || out[i] === undefined) out[i] = out[i - 1];
  }
  for (let i = out.length - 2; i >= 0; i--) {
    if (out[i] === null || out[i] === undefined) out[i] = out[i + 1];
  }
  return out.map((v) => v ?? 0);
}

// Sparse x-axis tick labels shared by drawStackedTrend/drawRecoveryBars -
// one label per bucket's own bucketStart, at that *same* bucket's own x
// position (via the caller's own xAt, not a separately-computed
// proportional timeline). Both charts below space their buckets evenly by
// array index, not by real elapsed time (a bucket with zero data just
// doesn't exist in the array at all, rather than leaving a stretched-out
// gap) - same convention TrendChart.vue/RecoveryTrendChart.vue already use
// live on the page, so labels positioned any other way would drift out of
// alignment with the bars/points they're meant to describe.
//
// Picks hour-of-day labels ("14:00") for a span under ~36h, day labels
// ("14.07") otherwise - mirrors StationHistoryChart.vue's own Chart.js
// time-scale unit choice, just hand-rolled since this is plain Canvas 2D.
function bucketTickLabels(buckets) {
  if (buckets.length < 2) return [];
  const first = new Date(buckets[0].bucketStart).getTime();
  const last = new Date(buckets[buckets.length - 1].bucketStart).getTime();
  const useHours = last - first <= 36 * 3600 * 1000;
  return buckets.map((b) => {
    const d = new Date(b.bucketStart);
    return useHours
      ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  });
}

// How many buckets to skip between labels so the widest one in `labels`
// never collides with its neighbor, given each bucket only has
// `perBucketWidth` px of its own (bar+gap, or point spacing). Exposed
// separately from the actual drawing (below) so drawRecoveryBars can fold
// its value labels' own width into the same step its time-axis labels use -
// one consistent, evenly-spaced subset of bars gets *both* callouts,
// instead of two independently-skipped sets that would look like a
// scattered mismatch.
function computeLabelStep(ctx, labels, perBucketWidth) {
  if (!labels.length) return 1;
  const maxLabelWidth = Math.max(...labels.map((l) => ctx.measureText(l).width));
  return Math.max(1, Math.ceil((maxLabelWidth + 14) / perBucketWidth));
}

// `xAt(i)` should return bucket i's own x-CENTER (matching how the caller
// already positions its bars/points).
function drawBucketAxisLabels(ctx, buckets, labels, xAt, step, y, chartX, chartWidth, font, color = '#94a3b8') {
  if (buckets.length < 2) return;
  ctx.font = font;
  ctx.fillStyle = color;
  for (let i = 0; i < buckets.length; i += step) {
    const labelWidth = ctx.measureText(labels[i]).width;
    const clampedX = Math.min(Math.max(xAt(i) - labelWidth / 2, chartX), chartX + chartWidth - labelWidth);
    ctx.fillText(labels[i], clampedX, y);
  }
}

// Stacked-area mini chart (available/maybe/not_available bands, bottom to
// top) plus a dashed forecast continuation - the compact equivalent of
// TrendChart.vue's full chart, not a single arbitrary-colored trend line:
// the graph shows *availability*, so it should use the app's own
// green/amber/red for that, not a color chosen by whether the trend is
// currently improving or worsening (a different, and previously
// conflated, piece of information - that's still shown separately as the
// direction badge and the delta line below the chart).
function drawStackedTrend(ctx, trendBuckets, forecastBuckets, x, y, width, height, draw) {
  if (!draw || trendBuckets.length < 2) return;

  const histLen = trendBuckets.length;
  const forecastLen = forecastBuckets.length;
  const totalPoints = histLen + forecastLen;
  const xStep = width / Math.max(1, totalPoints - 1);
  const xAt = (i) => x + i * xStep;

  ctx.strokeStyle = '#e5e7eb';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y + height);
  ctx.lineTo(x + width, y + height);
  ctx.stroke();

  const avail = fillGaps(trendBuckets.map((b) => b.availablePct));
  const maybe = fillGaps(trendBuckets.map((b) => b.maybeAvailablePct));
  const notAvail = fillGaps(trendBuckets.map((b) => b.notAvailablePct));
  const xs = trendBuckets.map((_, i) => xAt(i));
  const toY = (pct) => y + height - (Math.max(0, Math.min(100, pct)) / 100) * height;

  const baseline = xs.map(() => y + height);
  const topAvail = avail.map((v) => toY(v));
  const topMaybe = avail.map((v, i) => toY(v + maybe[i]));
  const topNotAvail = avail.map((v, i) => toY(v + maybe[i] + notAvail[i]));

  const drawBand = (topLine, bottomLine, color) => {
    ctx.beginPath();
    ctx.moveTo(xs[0], bottomLine[0]);
    for (let i = 0; i < xs.length; i++) ctx.lineTo(xs[i], bottomLine[i]);
    for (let i = xs.length - 1; i >= 0; i--) ctx.lineTo(xs[i], topLine[i]);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.3;
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.beginPath();
    ctx.moveTo(xs[0], topLine[0]);
    for (let i = 1; i < xs.length; i++) ctx.lineTo(xs[i], topLine[i]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
  };

  drawBand(topAvail, baseline, STATUS_COLORS.available);
  drawBand(topMaybe, topAvail, STATUS_COLORS.maybe_available);
  drawBand(topNotAvail, topMaybe, STATUS_COLORS.not_available);

  // Forecast continuation - only projects availability itself (not the
  // full breakdown), so it's drawn as a dashed line picking up from where
  // the green band's own top edge left off, not another stacked area.
  if (forecastLen > 0) {
    const forecastAvail = fillGaps(forecastBuckets.map((b) => b.availablePct));
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = FORECAST_COLOR;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(xs[xs.length - 1], topAvail[topAvail.length - 1]);
    for (let i = 0; i < forecastLen; i++) {
      ctx.lineTo(xAt(histLen + i), toY(forecastAvail[i]));
    }
    ctx.stroke();
    ctx.restore();
  }

  // Time-axis labels below the chart, positioned at each historical
  // bucket's own xAt(i) - see drawBucketAxisLabels's own doc comment for
  // why (not the forecast portion: it's already visually set apart by the
  // dashing/color, and doesn't need its own ticks to read clearly).
  const axisFont = '14px -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.font = axisFont;
  const tickLabels = bucketTickLabels(trendBuckets);
  const tickStep = computeLabelStep(ctx, tickLabels, xStep);
  drawBucketAxisLabels(ctx, trendBuckets, tickLabels, xAt, tickStep, y + height + 20, x, width, axisFont);
}

// Simple bar chart for average recovery time per bucket - same underlying
// data/bucketing as RecoveryTrendChart.vue's Chart.js bars on the reports
// page itself, redrawn in plain Canvas 2D like the rest of this card. No
// per-bar date labels (unlike the on-page version) - with up to ~19 bars
// for a 24h/hourly selection there isn't room to keep them legible at this
// card's fixed width, and the header/footer already carry the period's own
// date range. Both per-bar value labels ("5.2 ч") and a time-axis row below
// now share one auto-skipped subset of bars (see computeLabelStep's own
// doc comment) rather than trying to caption every single bar - with up to
// ~30 for a 30-day/daily selection there still isn't room for all of them
// individually, but a readable handful beats none.
function drawRecoveryBars(ctx, buckets, x, y, width, height, draw) {
  if (!draw || !buckets.length) return;
  const gap = Math.min(8, width / buckets.length / 4);
  const barWidth = (width - gap * (buckets.length - 1)) / buckets.length;
  const perBucketWidth = barWidth + gap;
  const xAt = (i) => x + i * perBucketWidth + barWidth / 2;

  // Headroom above the bars for their own value labels - the tallest bar
  // stops short of the very top of `height` instead of reaching it, so its
  // label has somewhere to sit without colliding with whatever's drawn
  // above this chart.
  const valueLabelSpace = 22;
  const barsAreaHeight = height - valueLabelSpace;
  const maxMinutes = Math.max(1, ...buckets.map((b) => b.avgRecoveryMinutes));

  const valueFont = '600 14px -apple-system, "Segoe UI", Roboto, sans-serif';
  const axisFont = '14px -apple-system, "Segoe UI", Roboto, sans-serif';
  const valueLabels = buckets.map((b) => formatMinutes(b.avgRecoveryMinutes));
  const tickLabels = bucketTickLabels(buckets);
  ctx.font = valueFont;
  const valueStep = computeLabelStep(ctx, valueLabels, perBucketWidth);
  ctx.font = axisFont;
  const tickStep = computeLabelStep(ctx, tickLabels, perBucketWidth);
  const step = Math.max(valueStep, tickStep);

  ctx.strokeStyle = '#e5e7eb';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y + height);
  ctx.lineTo(x + width, y + height);
  ctx.stroke();

  ctx.textAlign = 'center';
  buckets.forEach((b, i) => {
    const barHeight = Math.max(3, (b.avgRecoveryMinutes / maxMinutes) * barsAreaHeight);
    const bx = x + i * perBucketWidth;
    const by = y + height - barHeight;
    ctx.fillStyle = 'rgba(37, 99, 235, 0.75)';
    roundRect(ctx, bx, by, Math.max(1, barWidth), barHeight, Math.min(3, barWidth / 2));
    ctx.fill();

    if (i % step === 0) {
      ctx.fillStyle = '#1e3a8a';
      ctx.font = valueFont;
      ctx.fillText(valueLabels[i], bx + barWidth / 2, by - 6);
    }
  });
  ctx.textAlign = 'left';

  drawBucketAxisLabels(ctx, buckets, tickLabels, xAt, step, y + height + 20, x, width, axisFont);
}

// Runs the full layout against `ctx`; when `draw` is false, drawing calls
// are skipped (measureText still runs) so the same function can measure
// content height first, then draw for real on a canvas of that height -
// same two-pass approach as stationCard.js, for the same reason (a report
// with 0 top stations or no trend data shouldn't ship a card that's mostly
// empty space below a fixed height).
function layoutCard(
  ctx,
  { region, from, to, summary, trendBuckets, forecastBuckets, recoveryTrendBuckets, direction, topStations, stationsLabel },
  draw
) {
  const contentWidth = WIDTH - PADDING * 2;
  let y = PADDING + 20;

  ctx.font = '600 28px -apple-system, "Segoe UI", Roboto, sans-serif';
  if (draw) {
    ctx.fillStyle = '#14213d';
    ctx.fillText('⛽ Топливо — Мониторинг', PADDING, y);
  }
  ctx.font = '20px -apple-system, "Segoe UI", Roboto, sans-serif';
  const rangeLabel = formatDateRange(from, to);
  if (draw) {
    ctx.fillStyle = '#94a3b8';
    const rangeWidth = ctx.measureText(rangeLabel).width;
    ctx.fillText(rangeLabel, PADDING + contentWidth - rangeWidth, y);
  }

  y += 24;
  if (draw) {
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(PADDING, y);
    ctx.lineTo(PADDING + contentWidth, y);
    ctx.stroke();
  }
  y += 56;

  ctx.font = '700 44px -apple-system, "Segoe UI", Roboto, sans-serif';
  const nameLines = wrapText(ctx, region.name || 'Район', contentWidth).slice(0, 2);
  for (const line of nameLines) {
    if (draw) {
      ctx.fillStyle = '#0f172a';
      ctx.fillText(line, PADDING, y);
    }
    y += 52;
  }
  y += 44;

  // KPI row - one row of 4 tiles rather than stationCard's 2x2 grid, since
  // a report card only has one set of tiles to show (no separate "reliability"
  // sub-section competing for space).
  // sublabel (only the availability tile has one) - the metric quietly
  // narrowed to gasoline only (see metricsService.js's own doc comment on
  // CORE_FUEL_TYPES); called out here so the number doesn't read as an
  // unexplained change from what a report card used to show.
  const kpis = [
    {
      value: formatPct(summary.overallAvailablePct),
      label: 'Доступность',
      sublabel: 'АИ-92, АИ-95',
      color: availabilityColor(summary.overallAvailablePct),
    },
    { value: String(summary.stationCount), label: 'Станций', color: '#0f172a' },
    { value: String(summary.totalOutages), label: 'Отключений', color: '#0f172a' },
    { value: formatMinutes(summary.avgRecoveryMinutes), label: 'Ср. восстановление', color: '#0f172a' },
  ];
  const kpiGap = 20;
  const kpiWidth = (contentWidth - kpiGap * 3) / 4;
  const kpiHeight = 128;
  if (draw) {
    kpis.forEach((tile, i) => {
      const tx = PADDING + i * (kpiWidth + kpiGap);
      ctx.fillStyle = '#f8fafc';
      roundRect(ctx, tx, y, kpiWidth, kpiHeight, 14);
      ctx.fill();

      ctx.fillStyle = tile.color;
      ctx.font = '700 34px -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(tile.value, tx + kpiWidth / 2, y + 52);

      ctx.fillStyle = '#64748b';
      ctx.font = '19px -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.fillText(tile.label, tx + kpiWidth / 2, y + 84);

      if (tile.sublabel) {
        ctx.fillStyle = '#94a3b8';
        ctx.font = '15px -apple-system, "Segoe UI", Roboto, sans-serif';
        ctx.fillText(tile.sublabel, tx + kpiWidth / 2, y + 106);
      }
      ctx.textAlign = 'left';
    });
  }
  y += kpiHeight + 48;

  // Trend section: title + direction badge + sparkline + start-vs-end delta.
  // Same "(АИ-92, АИ-95)" qualifier ReportsView.vue's own on-page heading
  // has, for consistency between the two.
  if (draw) {
    ctx.fillStyle = '#0f172a';
    ctx.font = '600 28px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.fillText('Динамика доступности', PADDING, y);
    const titleWidth = ctx.measureText('Динамика доступности').width;
    ctx.fillStyle = '#94a3b8';
    ctx.font = '20px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.fillText(' (АИ-92, АИ-95)', PADDING + titleWidth, y);
  }
  const dirMeta = DIRECTION_META[direction] || DIRECTION_META.unknown;
  if (draw) {
    ctx.fillStyle = dirMeta.color;
    ctx.font = '600 22px -apple-system, "Segoe UI", Roboto, sans-serif';
    const dirLabel = `${dirMeta.icon} ${dirMeta.label}`.trim();
    const dirWidth = ctx.measureText(dirLabel).width;
    ctx.fillText(dirLabel, PADDING + contentWidth - dirWidth, y);
  }
  y += 28;

  if (trendBuckets.length > 1) {
    const sparkHeight = 90;
    const delta = computeTrendDelta(trendBuckets);
    const sparkColor = delta === null ? '#6b7280' : delta > 1 ? '#16a34a' : delta < -1 ? '#dc2626' : '#6b7280';
    drawStackedTrend(ctx, trendBuckets, forecastBuckets || [], PADDING, y, contentWidth, sparkHeight, draw);
    // +24 over the old spacing to fit the new time-axis label row drawn
    // just below the chart (see drawStackedTrend's own call to
    // drawBucketAxisLabels) before the delta text below it.
    y += sparkHeight + 52;

    if (draw && delta !== null) {
      const sign = delta > 0 ? '+' : '';
      ctx.fillStyle = sparkColor;
      ctx.font = '600 20px -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.fillText(`${sign}${delta.toFixed(0)}% за период (от начала к концу)`, PADDING, y);
    }
    y += 40;
  } else {
    if (draw) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '20px -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.fillText('Недостаточно данных для графика', PADDING, y + 20);
    }
    y += 60;
  }

  y += 16;

  // Recovery-time bars - same data/bucketing as the reports page's own
  // "Время восстановления после отключений" section (RecoveryTrendChart.vue).
  // Qualifier drawn on its own line below the title, not appended inline
  // like the shorter "Динамика доступности" heading above - this title is
  // already long enough that appending " (АИ-92, АИ-95)" at 1000px card
  // width risked crowding the right edge.
  if (draw) {
    ctx.fillStyle = '#0f172a';
    ctx.font = '600 28px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.fillText('Время восстановления после отключений', PADDING, y);
  }
  y += 26;
  if (draw) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '18px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.fillText('АИ-92, АИ-95', PADDING, y);
  }
  y += 22;

  if (recoveryTrendBuckets.length) {
    const barsHeight = 90;
    drawRecoveryBars(ctx, recoveryTrendBuckets, PADDING, y, contentWidth, barsHeight, draw);
    // Same +24 as drawStackedTrend above, for its own new time-axis label row.
    y += barsHeight + 52;

    if (draw) {
      const worst = recoveryTrendBuckets.reduce((a, b) => (b.avgRecoveryMinutes > a.avgRecoveryMinutes ? b : a));
      ctx.fillStyle = '#64748b';
      ctx.font = '600 20px -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.fillText(`Дольше всего — ${formatMinutes(worst.avgRecoveryMinutes)} в среднем`, PADDING, y);
    }
    y += 40;
  } else {
    if (draw) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '20px -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.fillText('За период не было отключений с восстановлением', PADDING, y + 20);
    }
    y += 60;
  }

  y += 16;

  // Top stations (best or worst, matching whichever sort tab was active on
  // the page when the card was generated).
  if (topStations.length) {
    if (draw) {
      ctx.fillStyle = '#0f172a';
      ctx.font = '600 28px -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.fillText(stationsLabel, PADDING, y);
    }
    y += 20;

    for (const s of topStations) {
      y += 44;
      if (draw) {
        ctx.beginPath();
        ctx.arc(PADDING + 10, y - 9, 10, 0, Math.PI * 2);
        ctx.fillStyle = availabilityColor(s.availablePct);
        ctx.fill();

        ctx.fillStyle = '#0f172a';
        ctx.font = '600 25px -apple-system, "Segoe UI", Roboto, sans-serif';
        const nameText = s.address ? `${s.name || 'АЗС'}` : s.name || 'АЗС';
        ctx.fillText(nameText, PADDING + 34, y);

        ctx.fillStyle = availabilityColor(s.availablePct);
        ctx.font = '700 25px -apple-system, "Segoe UI", Roboto, sans-serif';
        const pctText = formatPct(s.availablePct);
        const pctWidth = ctx.measureText(pctText).width;
        ctx.fillText(pctText, PADDING + contentWidth - pctWidth, y);

        if (s.address) {
          ctx.fillStyle = '#64748b';
          ctx.font = '19px -apple-system, "Segoe UI", Roboto, sans-serif';
          ctx.fillText(s.address, PADDING + 34, y + 22);
        }
      }
      if (s.address) y += 22;

      // Compact best-of status ribbon for this station's own period - same
      // real segments StationReliabilityTimeline.vue draws (fetched by the
      // caller, see ReportsView.vue's generateReportCard), just shorter
      // (14px, one combined row) to fit three of them on a card that
      // already has plenty else on it. No hint text here on purpose - a
      // static image has no hover interaction to explain - but day-boundary
      // date labels ARE kept, same approach as the live ribbon
      // (StationReliabilityTimeline.vue's own dayTicks): every local
      // midnight within the range gets a tick, auto-thinned by
      // computeLabelStep below once there are too many to fit without
      // overlapping - a single "start – end" label pair alone wasn't enough
      // to place a mid-week block in time at a glance, confirmed live.
      if (s.ribbon && s.ribbon.length) {
        y += 10;
        const ribbonHeight = 14;
        const ribbonX = PADDING + 34;
        const ribbonWidth = contentWidth - 34;
        const rangeStart = new Date(s.ribbonRangeStart).getTime();
        const rangeEnd = new Date(s.ribbonRangeEnd).getTime();
        const totalMs = Math.max(1, rangeEnd - rangeStart);
        if (draw) {
          ctx.save();
          roundRect(ctx, ribbonX, y, ribbonWidth, ribbonHeight, 4);
          ctx.clip();
          let sx = ribbonX;
          for (const seg of s.ribbon) {
            const segWidth = ((new Date(seg.end).getTime() - new Date(seg.start).getTime()) / totalMs) * ribbonWidth;
            ctx.fillStyle = statusMeta(seg.status).color;
            ctx.fillRect(sx, y, Math.max(segWidth, 0.5), ribbonHeight);
            sx += segWidth;
          }
          ctx.restore();
        }
        y += ribbonHeight + 16;
        if (draw) {
          ctx.fillStyle = '#94a3b8';
          ctx.font = '15px -apple-system, "Segoe UI", Roboto, sans-serif';
          const dayTicks = [];
          const d = new Date(rangeStart);
          d.setHours(24, 0, 0, 0); // first midnight strictly after rangeStart
          while (d.getTime() < rangeEnd) {
            dayTicks.push({
              tx: ribbonX + ((d.getTime() - rangeStart) / totalMs) * ribbonWidth,
              label: d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }),
            });
            d.setDate(d.getDate() + 1);
          }
          // Same collision-avoidance computeLabelStep already gives the
          // trend/recovery charts above, applied here too - the reports
          // page's own period can now reach 90+ days (see
          // ReportsView.vue's presets), and one label per calendar day
          // crammed into this ribbon's width used to render as an
          // unreadable jumble of digits well before that (confirmed live).
          const step = computeLabelStep(
            ctx,
            dayTicks.map((t) => t.label),
            ribbonWidth / Math.max(1, dayTicks.length)
          );
          dayTicks.forEach((tick, i) => {
            if (i % step !== 0) return;
            const labelWidth = ctx.measureText(tick.label).width;
            const clampedX = Math.min(Math.max(tick.tx - labelWidth / 2, ribbonX), ribbonX + ribbonWidth - labelWidth);
            ctx.fillText(tick.label, clampedX, y);
          });
        }
      }
    }
    y += 24;
  }

  // Footer: pinned right after the content, not at a fixed canvas bottom.
  const footerY = y + FOOTER_HEIGHT - 42;
  if (draw) {
    ctx.strokeStyle = '#e5e7eb';
    ctx.beginPath();
    ctx.moveTo(PADDING, footerY - 32);
    ctx.lineTo(PADDING + contentWidth, footerY - 32);
    ctx.stroke();
    ctx.fillStyle = '#94a3b8';
    ctx.font = '22px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.fillText(rangeLabel, PADDING, footerY);
    ctx.font = '20px -apple-system, "Segoe UI", Roboto, sans-serif';
    const brand = 'tbenz.in · t.me/tbenzin';
    const brandWidth = ctx.measureText(brand).width;
    ctx.fillText(brand, PADDING + contentWidth - brandWidth, footerY);
  }
  // Extra clearance below the footer text - see mapShareCard.js's own
  // identical comment: the -42/-20 offset pairing left the text baseline
  // sitting below the white card's visible bottom edge (24px inset) on
  // every card, not just some.
  y += FOOTER_HEIGHT + 6;

  return Math.round(y);
}

/**
 * Draws a shareable "region report card" (KPIs, trend, top stations) for a
 * chosen period and resolves with a PNG Blob. Pure Canvas 2D, via the shared
 * measure-then-draw runner (canvasDraw.js's renderCard) also used by
 * stationCard.js/mapShareCard.js, so the card's height fits its actual
 * content instead of shipping a fixed size with empty space when there's no
 * trend data or no top stations yet.
 */
export function renderRegionReportCard({
  region,
  from,
  to,
  summary,
  trendBuckets,
  forecastBuckets,
  recoveryTrendBuckets,
  direction,
  topStations,
  stationsLabel,
}) {
  const payload = {
    region,
    from,
    to,
    summary,
    trendBuckets: trendBuckets || [],
    forecastBuckets: forecastBuckets || [],
    recoveryTrendBuckets: recoveryTrendBuckets || [],
    direction,
    topStations: topStations || [],
    stationsLabel,
  };
  return renderCard(layoutCard, payload, { width: WIDTH });
}
