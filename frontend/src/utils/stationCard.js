import { statusMeta, fuelTypeLabel } from './fuelStatus';
import { availabilityColor, formatPct, formatMinutes } from './colorScale';

const WIDTH = 1000;
const PADDING = 56;
const FOOTER_HEIGHT = 90;

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapText(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const attempt = current ? `${current} ${word}` : word;
    if (current && ctx.measureText(attempt).width > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = attempt;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function formatDateTime(value) {
  if (!value) return '';
  return new Date(value).toLocaleString('ru-RU');
}

// Runs the full card layout against `ctx`. When `draw` is false, every
// fillRect/stroke/fill call is skipped (measureText still runs, since that's
// how we find out how many lines a name/address wraps to) - so this same
// function can be called once to measure how tall the content actually is,
// then again on a canvas of exactly that height to draw for real, instead of
// shipping one fixed-height canvas with a lot of empty space for the common
// case of a station with just 1-2 fuel types and no reliability data yet.
function layoutCard(ctx, { station, reliability }, draw) {
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
  y += badgeHeight + 48;

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
      { value: formatPct(reliability.availablePct), label: 'Доступность', color: availabilityColor(reliability.availablePct) },
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
 * so a station with one fuel type and no reliability data yet doesn't ship
 * a card that's mostly empty space.
 */
export function renderStationCard({ station, reliability }) {
  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');
  const height = layoutCard(measureCtx, { station, reliability }, false);

  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#f4f6f8';
  ctx.fillRect(0, 0, WIDTH, height);
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, 24, 24, WIDTH - 48, height - 48, 24);
  ctx.fill();

  layoutCard(ctx, { station, reliability }, true);

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
