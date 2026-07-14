import {
  statusMeta,
  fuelTypeLabel,
  bestFuelStatus,
  CORE_FUEL_TYPES,
  computeStatusSegments,
  collapseIsolatedBlips,
} from './fuelStatus';
import { availabilityColor, formatPct, formatMinutes } from './colorScale';
import { downsampleEvenly } from './mapExport';
import { roundRect, wrapText, renderCard } from './canvasDraw';

const WIDTH = 1000;
const PADDING = 56;
const FOOTER_HEIGHT = 90;
const MAX_STRIP_SEGMENTS = 40;

function formatDateTime(value) {
  if (!value) return '';
  return new Date(value).toLocaleString('ru-RU');
}

function formatHour(value) {
  if (!value) return '';
  return new Date(value).toLocaleString('ru-RU', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

// Groups a station's history (array of { polledAt, fuelStatuses }) into one
// chronological status series per fuel type.
function buildFuelSeries(history) {
  const byType = new Map();
  for (const snap of history || []) {
    for (const f of snap.fuelStatuses || []) {
      if (!byType.has(f.fuelType)) byType.set(f.fuelType, []);
      byType.get(f.fuelType).push({ polledAt: snap.polledAt, status: f.status });
    }
  }
  return byType;
}

// Runs the full card layout against `ctx`. When `draw` is false, every
// fillRect/stroke/fill call is skipped (measureText still runs, since that's
// how we find out how many lines a name/address wraps to, and how many fuel
// types have history) - so this same function can be called once to measure
// how tall the content actually is, then again on a canvas of exactly that
// height to draw for real, instead of shipping one fixed-height canvas with
// a lot of empty space for the common case of a station with just 1-2 fuel
// types and no reliability/history data yet.
function layoutCard(ctx, { station, reliability, forecast, history }, draw) {
  const contentWidth = WIDTH - PADDING * 2;
  let y = PADDING + 20;

  ctx.font = '600 28px -apple-system, "Segoe UI", Roboto, sans-serif';
  if (draw) {
    ctx.fillStyle = '#14213d';
    ctx.fillText('⛽ Топливо — Мониторинг', PADDING, y);
  }
  ctx.font = '20px -apple-system, "Segoe UI", Roboto, sans-serif';
  const generatedLabel = formatDateTime(new Date());
  if (draw) {
    ctx.fillStyle = '#94a3b8';
    const generatedWidth = ctx.measureText(generatedLabel).width;
    ctx.fillText(generatedLabel, PADDING + contentWidth - generatedWidth, y);
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
  const nameLines = wrapText(ctx, station.name || 'АЗС', contentWidth).slice(0, 2);
  for (const line of nameLines) {
    if (draw) {
      ctx.fillStyle = '#0f172a';
      ctx.fillText(line, PADDING, y);
    }
    y += 52;
  }

  if (station.address) {
    ctx.font = '26px -apple-system, "Segoe UI", Roboto, sans-serif';
    const addressLines = wrapText(ctx, station.address, contentWidth).slice(0, 2);
    for (const line of addressLines) {
      if (draw) {
        ctx.fillStyle = '#64748b';
        ctx.fillText(line, PADDING, y);
      }
      y += 34;
    }
  }

  y += 20;

  // Gasoline-only badge (bestFuelStatus's own CORE_FUEL_TYPES default) -
  // not station.status, which is an independent per-source vote across
  // every fuel type a station sells and can disagree with the
  // gasoline-only picture the rest of the card (and app) already shows.
  const overallMeta = statusMeta(bestFuelStatus(station.fuelStatuses));
  const badgeHeight = 64;
  if (draw) {
    ctx.fillStyle = overallMeta.color;
    roundRect(ctx, PADDING, y, contentWidth, badgeHeight, badgeHeight / 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 30px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(overallMeta.label, PADDING + 28, y + badgeHeight / 2 + 2);
    ctx.textBaseline = 'alphabetic';
  }
  y += badgeHeight + 32;

  // One-line recovery estimate, only relevant while the station is down -
  // mirrors StationForecast.vue's own hint text/conditions exactly.
  if (forecast && forecast.currentStatus === 'not_available') {
    const recoveryText = forecast.estimatedRecoveryAt
      ? `Ожидаемое восстановление: ~${formatHour(forecast.estimatedRecoveryAt)} (по истории станции)`
      : 'Недостаточно истории, чтобы оценить время восстановления';
    ctx.font = '600 24px -apple-system, "Segoe UI", Roboto, sans-serif';
    if (draw) {
      ctx.fillStyle = '#b45309';
      ctx.fillText(recoveryText, PADDING, y);
    }
    y += 40;
  }

  y += 16;

  if (draw) {
    ctx.fillStyle = '#0f172a';
    ctx.font = '600 28px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.fillText('Виды топлива', PADDING, y);
  }
  y += 20;

  const fuelStatuses = station.fuelStatuses || [];
  for (const f of fuelStatuses) {
    y += 44;
    if (draw) {
      const meta = statusMeta(f.status);
      ctx.beginPath();
      ctx.arc(PADDING + 10, y - 9, 10, 0, Math.PI * 2);
      ctx.fillStyle = meta.color;
      ctx.fill();

      ctx.fillStyle = '#0f172a';
      ctx.font = '600 26px -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.fillText(fuelTypeLabel(f.fuelType), PADDING + 34, y);

      ctx.fillStyle = '#475569';
      ctx.font = '26px -apple-system, "Segoe UI", Roboto, sans-serif';
      const labelWidth = ctx.measureText(meta.label).width;
      ctx.fillText(meta.label, PADDING + contentWidth - labelWidth, y);
    }
  }
  y += 56;

  if (reliability) {
    if (draw) {
      ctx.fillStyle = '#0f172a';
      ctx.font = '600 28px -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.fillText('Надёжность за 7 дней', PADDING, y);
    }
    y += 24;

    const tiles = [
      {
        value: formatPct(reliability.availablePct),
        // The metric quietly narrowed to gasoline only (see
        // metricsService.js's own doc comment on CORE_FUEL_TYPES) - called
        // out here, unlike the other tiles' plain labels, so the number
        // doesn't read as an unexplained change.
        label: 'Доступность (АИ-92, АИ-95)',
        color: availabilityColor(reliability.availablePct),
      },
      { value: formatPct(reliability.noDataPct), label: 'Нет данных', color: '#0f172a' },
      { value: String(reliability.outageCount), label: 'Отключений', color: '#0f172a' },
      { value: formatMinutes(reliability.avgOutageMinutes), label: 'Ср. восстановление', color: '#0f172a' },
    ];

    const gap = 20;
    const tileWidth = (contentWidth - gap) / 2;
    const tileHeight = 120;
    if (draw) {
      tiles.forEach((tile, idx) => {
        const col = idx % 2;
        const row = Math.floor(idx / 2);
        const tx = PADDING + col * (tileWidth + gap);
        const ty = y + row * (tileHeight + gap);

        ctx.fillStyle = '#f8fafc';
        roundRect(ctx, tx, ty, tileWidth, tileHeight, 14);
        ctx.fill();

        ctx.fillStyle = tile.color;
        ctx.font = '700 40px -apple-system, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(tile.value, tx + tileWidth / 2, ty + 58);

        ctx.fillStyle = '#64748b';
        ctx.font = '22px -apple-system, "Segoe UI", Roboto, sans-serif';
        ctx.fillText(tile.label, tx + tileWidth / 2, ty + 92);
        ctx.textAlign = 'left';
      });
    }

    y += 2 * tileHeight + gap + 40;
  }

  // Status ribbon: same idea as the live page's own
  // StationReliabilityTimeline.vue - real segments (not bucketed/
  // downsampled) with isolated single-poll blips collapsed away (see
  // fuelStatus.js's collapseIsolatedBlips), drawn as one proportional-width
  // bar. Replaces the old "Последние отключения" bar list - this ribbon
  // already shows exactly when and how long each outage was, at a glance,
  // without a separate list needed alongside it.
  const ribbonSegments = collapseIsolatedBlips(computeStatusSegments(history));
  if (ribbonSegments.length) {
    if (draw) {
      ctx.fillStyle = '#0f172a';
      ctx.font = '600 28px -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.fillText('Лента статусов за 7 дней (АИ-92, АИ-95)', PADDING, y);
    }
    y += 20;

    const rangeStart = new Date(ribbonSegments[0].start).getTime();
    const rangeEnd = new Date(ribbonSegments[ribbonSegments.length - 1].end).getTime();
    const totalMs = Math.max(1, rangeEnd - rangeStart);
    const ribbonHeight = 32;

    if (draw) {
      ctx.save();
      roundRect(ctx, PADDING, y, contentWidth, ribbonHeight, 6);
      ctx.clip();
      let sx = PADDING;
      for (const seg of ribbonSegments) {
        const segWidth = ((new Date(seg.end).getTime() - new Date(seg.start).getTime()) / totalMs) * contentWidth;
        ctx.fillStyle = statusMeta(seg.status).color;
        ctx.fillRect(sx, y, Math.max(segWidth, 0.5), ribbonHeight);
        sx += segWidth;
      }
      ctx.restore();
    }
    y += ribbonHeight + 22;

    // Day-boundary tick labels for orientation, same approach as the live
    // ribbon - positioned by percentage along the range, not tied to
    // segment edges (segments follow real poll timestamps, not midnight).
    if (draw) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '18px -apple-system, "Segoe UI", Roboto, sans-serif';
      const d = new Date(rangeStart);
      d.setHours(24, 0, 0, 0);
      while (d.getTime() < rangeEnd) {
        const tx = PADDING + ((d.getTime() - rangeStart) / totalMs) * contentWidth;
        const label = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
        const labelWidth = ctx.measureText(label).width;
        const clampedX = Math.min(Math.max(tx - labelWidth / 2, PADDING), PADDING + contentWidth - labelWidth);
        ctx.fillText(label, clampedX, y);
        d.setDate(d.getDate() + 1);
      }
    }
    y += 36;
  }

  // Compact fuel history: one horizontal strip per fuel type, each segment a
  // status color in chronological order (oldest -> newest, left -> right).
  // Deliberately not a full axis-and-legend line chart like
  // StationHistoryChart.vue - this needs to read at a glance in a shared
  // image, not be analyzed, so it trades precision for compactness.
  //
  // Gasoline only, same CORE_FUEL_TYPES default as everywhere else (see
  // metricsService.js's own doc comment) - unlike the live page's own
  // history chart (StationHistoryChart.vue), a static shared image has no
  // clickable legend to bring the other fuel types back, so they're left
  // off entirely here rather than drawn hidden. Fixed order (92 before 95),
  // not history's own insertion order, for a consistent shared image
  // regardless of which type happened to be seen first in this window.
  const fuelSeries = buildFuelSeries(history);
  const coreFuelEntries = CORE_FUEL_TYPES.filter((t) => fuelSeries.has(t)).map((t) => [t, fuelSeries.get(t)]);
  if (coreFuelEntries.length) {
    if (draw) {
      ctx.fillStyle = '#0f172a';
      ctx.font = '600 28px -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.fillText('История по видам топлива (АИ-92, АИ-95)', PADDING, y);
    }
    y += 20;

    const stripHeight = 22;
    const labelWidth = 90;
    const stripAreaWidth = contentWidth - labelWidth;
    const segGap = 3;

    for (const [fuelType, series] of coreFuelEntries) {
      y += 36;
      const sampled = downsampleEvenly(series, MAX_STRIP_SEGMENTS);
      if (draw) {
        ctx.fillStyle = '#0f172a';
        ctx.font = '600 22px -apple-system, "Segoe UI", Roboto, sans-serif';
        ctx.fillText(fuelTypeLabel(fuelType), PADDING, y + stripHeight - 4);

        const segWidth = (stripAreaWidth - segGap * (sampled.length - 1)) / sampled.length;
        sampled.forEach((point, i) => {
          const sx = PADDING + labelWidth + i * (segWidth + segGap);
          ctx.fillStyle = statusMeta(point.status).color;
          roundRect(ctx, sx, y, Math.max(segWidth, 1), stripHeight, 3);
          ctx.fill();
        });
      }
      y += stripHeight;
    }

    if (draw && history?.length) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '20px -apple-system, "Segoe UI", Roboto, sans-serif';
      const rangeLabel = `${formatDateTime(history[0].polledAt)} — ${formatDateTime(history[history.length - 1].polledAt)}`;
      ctx.fillText(rangeLabel, PADDING + labelWidth, y + 26);
    }
    y += 40;
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
    const snapshotLabel = station.polledAt
      ? `Снимок на момент: ${formatDateTime(station.polledAt)}`
      : '';
    ctx.fillText(snapshotLabel, PADDING, footerY);
  }
  y += FOOTER_HEIGHT - 20;

  return Math.round(y);
}

/**
 * Draws a shareable "station stat card" and resolves with a PNG Blob. Pure
 * Canvas 2D drawing (no map tiles, no external assets) so it works offline
 * and instantly, unlike the map GIF/video export which depends on tile
 * availability and takes real time to render frame by frame. Height is
 * sized to the actual content (measured in a first pass) rather than fixed,
 * so a station with one fuel type and no reliability/history data yet
 * doesn't ship a card that's mostly empty space. `forecast` and `history`
 * are optional - their sections are simply omitted when not supplied.
 */
export function renderStationCard({ station, reliability, forecast, history }) {
  return renderCard(layoutCard, { station, reliability, forecast, history }, { width: WIDTH });
}

export function canCopyImageToClipboard() {
  return (
    typeof ClipboardItem !== 'undefined' &&
    typeof navigator.clipboard?.write === 'function' &&
    (typeof ClipboardItem.supports !== 'function' || ClipboardItem.supports('image/png'))
  );
}
