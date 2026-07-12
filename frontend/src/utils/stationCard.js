import { statusMeta, fuelTypeLabel } from './fuelStatus';
import { availabilityColor, formatPct, formatMinutes } from './colorScale';
import { downsampleEvenly } from './mapExport';
import { roundRect, wrapText } from './canvasDraw';

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

  const overallMeta = statusMeta(station.status);
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

  // Compact fuel history: one horizontal strip per fuel type, each segment a
  // status color in chronological order (oldest -> newest, left -> right).
  // Deliberately not a full axis-and-legend line chart like
  // StationHistoryChart.vue - this needs to read at a glance in a shared
  // image, not be analyzed, so it trades precision for compactness.
  const fuelSeries = buildFuelSeries(history);
  if (fuelSeries.size) {
    if (draw) {
      ctx.fillStyle = '#0f172a';
      ctx.font = '600 28px -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.fillText('История по видам топлива', PADDING, y);
    }
    y += 20;

    const stripHeight = 22;
    const labelWidth = 90;
    const stripAreaWidth = contentWidth - labelWidth;
    const segGap = 3;

    for (const [fuelType, series] of fuelSeries.entries()) {
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
  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');
  const height = layoutCard(measureCtx, { station, reliability, forecast, history }, false);

  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#f4f6f8';
  ctx.fillRect(0, 0, WIDTH, height);
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, 24, 24, WIDTH - 48, height - 48, 24);
  ctx.fill();

  layoutCard(ctx, { station, reliability, forecast, history }, true);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Не удалось создать изображение'));
    }, 'image/png');
  });
}

export function canCopyImageToClipboard() {
  return (
    typeof ClipboardItem !== 'undefined' &&
    typeof navigator.clipboard?.write === 'function' &&
    (typeof ClipboardItem.supports !== 'function' || ClipboardItem.supports('image/png'))
  );
}
