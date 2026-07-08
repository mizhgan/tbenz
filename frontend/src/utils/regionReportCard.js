import { availabilityColor, formatPct, formatMinutes } from './colorScale';
import { roundRect, wrapText } from './canvasDraw';

const WIDTH = 1000;
const PADDING = 56;
const FOOTER_HEIGHT = 80;

const DIRECTION_META = {
  improving: { label: 'Улучшается', icon: '↗', color: '#16a34a' },
  worsening: { label: 'Ухудшается', icon: '↘', color: '#dc2626' },
  stable: { label: 'Стабильно', icon: '→', color: '#6b7280' },
  unknown: { label: 'Недостаточно данных', icon: '', color: '#6b7280' },
};

function formatDateRange(from, to) {
  const fromD = new Date(from);
  const toD = new Date(to);
  const spanMs = toD.getTime() - fromD.getTime();
  const dateFmt = (d) => d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  const timeFmt = (d) => d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (spanMs > 36 * 3600 * 1000) {
    return `${dateFmt(fromD)}–${dateFmt(toD)}`;
  }
  return `${dateFmt(toD)} ${timeFmt(fromD)}–${timeFmt(toD)}`;
}

// Change from the first to the last bucket that actually has data - "how
// did it move over the period", not a statistically fitted trend (that's
// what the dashed forecast line on the page itself is for).
function computeTrendDelta(buckets) {
  const known = (buckets || []).filter((b) => b.availablePct !== null && b.availablePct !== undefined);
  if (known.length < 2) return null;
  return known[known.length - 1].availablePct - known[0].availablePct;
}

function drawSparkline(ctx, buckets, x, y, width, height, color, draw) {
  if (!draw || !buckets.length) return;
  const step = width / Math.max(1, buckets.length - 1);
  const points = buckets.map((b, i) => {
    const pct = b.availablePct;
    const py = pct === null || pct === undefined ? null : y + height - (Math.max(0, Math.min(100, pct)) / 100) * height;
    return { x: x + i * step, y: py };
  });

  ctx.strokeStyle = '#e5e7eb';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y + height);
  ctx.lineTo(x + width, y + height);
  ctx.stroke();

  // Segments break at gaps (buckets with no known data) instead of
  // interpolating straight through them - a gap means "we don't know", not
  // "it dropped to 0%" (same reasoning as the Telegram digest card).
  const segments = [];
  let current = [];
  for (const p of points) {
    if (p.y === null) {
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push(p);
    }
  }
  if (current.length) segments.push(current);

  for (const seg of segments) {
    if (seg.length < 2) continue;

    ctx.beginPath();
    ctx.moveTo(seg[0].x, y + height);
    for (const p of seg) ctx.lineTo(p.x, p.y);
    ctx.lineTo(seg[seg.length - 1].x, y + height);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.12;
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.beginPath();
    ctx.moveTo(seg[0].x, seg[0].y);
    for (const p of seg.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
}

// Runs the full layout against `ctx`; when `draw` is false, drawing calls
// are skipped (measureText still runs) so the same function can measure
// content height first, then draw for real on a canvas of that height -
// same two-pass approach as stationCard.js, for the same reason (a report
// with 0 top stations or no trend data shouldn't ship a card that's mostly
// empty space below a fixed height).
function layoutCard(ctx, { region, from, to, summary, trendBuckets, direction, topStations, stationsLabel }, draw) {
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
  const kpis = [
    { value: formatPct(summary.overallAvailablePct), label: 'Доступность', color: availabilityColor(summary.overallAvailablePct) },
    { value: String(summary.stationCount), label: 'Станций', color: '#0f172a' },
    { value: String(summary.totalOutages), label: 'Отключений', color: '#0f172a' },
    { value: formatMinutes(summary.avgRecoveryMinutes), label: 'Ср. восстановление', color: '#0f172a' },
  ];
  const kpiGap = 20;
  const kpiWidth = (contentWidth - kpiGap * 3) / 4;
  const kpiHeight = 110;
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
      ctx.textAlign = 'left';
    });
  }
  y += kpiHeight + 48;

  // Trend section: title + direction badge + sparkline + start-vs-end delta.
  if (draw) {
    ctx.fillStyle = '#0f172a';
    ctx.font = '600 28px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.fillText('Динамика доступности', PADDING, y);
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

  if (trendBuckets.length) {
    const sparkHeight = 90;
    const delta = computeTrendDelta(trendBuckets);
    const sparkColor = delta === null ? '#6b7280' : delta > 1 ? '#16a34a' : delta < -1 ? '#dc2626' : '#6b7280';
    drawSparkline(ctx, trendBuckets, PADDING, y, contentWidth, sparkHeight, sparkColor, draw);
    y += sparkHeight + 28;

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
    const brand = 'tbenz.in';
    const brandWidth = ctx.measureText(brand).width;
    ctx.fillText(brand, PADDING + contentWidth - brandWidth, footerY);
  }
  y += FOOTER_HEIGHT - 20;

  return Math.round(y);
}

/**
 * Draws a shareable "region report card" (KPIs, trend, top stations) for a
 * chosen period and resolves with a PNG Blob. Pure Canvas 2D, same
 * measure-then-draw approach as stationCard.js, so the card's height fits
 * its actual content instead of shipping a fixed size with empty space when
 * there's no trend data or no top stations yet.
 */
export function renderRegionReportCard({ region, from, to, summary, trendBuckets, direction, topStations, stationsLabel }) {
  const payload = {
    region,
    from,
    to,
    summary,
    trendBuckets: trendBuckets || [],
    direction,
    topStations: topStations || [],
    stationsLabel,
  };

  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');
  const height = layoutCard(measureCtx, payload, false);

  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#f4f6f8';
  ctx.fillRect(0, 0, WIDTH, height);
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, 24, 24, WIDTH - 48, height - 48, 24);
  ctx.fill();

  layoutCard(ctx, payload, true);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Не удалось создать изображение'));
    }, 'image/png');
  });
}
