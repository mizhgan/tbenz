import { availabilityColor, formatPct } from './colorScale';
import { roundRect, wrapText } from './canvasDraw';

const WIDTH = 1000;
const PADDING = 56;
const FOOTER_HEIGHT = 80;
// Map images are usually wide/short (a browser viewport) - capping the
// drawn height keeps a very tall/narrow map container (an unusual window
// shape) from producing an oddly elongated card.
const MAX_MAP_HEIGHT = 560;
// The map image gets scaled down from whatever size it was captured at
// on-screen to fit this exact width (see layoutCard's ctx.drawImage below)
// - exported so the caller (MapView.vue's generateShareCard) can draw its
// station markers at a radius pre-inflated to compensate, instead of the
// same fixed on-screen radius shrinking along with everything else on a
// wide desktop capture (markers in a dense cluster blurred into one
// indistinct blob at the card's fixed output size - see mapShareCard's
// git history for the specific report this fixed).
export const MAP_CONTENT_WIDTH = WIDTH - PADDING * 2;

const STATUS_TILES = [
  { key: 'available', label: 'Доступно', color: '#16a34a' },
  { key: 'maybe_available', label: 'Частично', color: '#d97706' },
  { key: 'not_available', label: 'Нет', color: '#dc2626' },
  { key: 'no_data', label: 'Нет данных', color: '#6b7280' },
];

function formatDateTime(ms) {
  return new Date(ms).toLocaleString('ru-RU');
}

// Same two-pass measure-then-draw approach as stationCard.js/regionReportCard.js
// - `draw` false only measures (so the canvas can be sized to fit the actual
// content), true actually paints.
function layoutCard(ctx, { regionName, mapCanvas, counts, stationCount, availablePct, generatedAt }, draw) {
  const contentWidth = WIDTH - PADDING * 2;
  let y = PADDING + 20;

  ctx.font = '600 28px -apple-system, "Segoe UI", Roboto, sans-serif';
  if (draw) {
    ctx.fillStyle = '#14213d';
    ctx.fillText('⛽ Топливо — Мониторинг', PADDING, y);
  }
  ctx.font = '20px -apple-system, "Segoe UI", Roboto, sans-serif';
  const tsLabel = formatDateTime(generatedAt);
  if (draw) {
    ctx.fillStyle = '#94a3b8';
    const tsWidth = ctx.measureText(tsLabel).width;
    ctx.fillText(tsLabel, PADDING + contentWidth - tsWidth, y);
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
  const nameLines = wrapText(ctx, regionName || 'Район', contentWidth).slice(0, 2);
  for (const line of nameLines) {
    if (draw) {
      ctx.fillStyle = '#0f172a';
      ctx.fillText(line, PADDING, y);
    }
    y += 52;
  }
  y += 12;

  // Headline percentage, same color language as the map's own markers -
  // reads as "the same map, summarized in one number" rather than an
  // arbitrarily colored KPI.
  const pctColor = availabilityColor(availablePct);
  const pctText = formatPct(availablePct);
  ctx.font = '700 60px -apple-system, "Segoe UI", Roboto, sans-serif';
  if (draw) {
    ctx.fillStyle = pctColor;
    ctx.fillText(pctText, PADDING, y + 48);
  }
  ctx.font = '20px -apple-system, "Segoe UI", Roboto, sans-serif';
  if (draw) {
    ctx.fillStyle = '#64748b';
    ctx.fillText('доступность сейчас', PADDING + 210, y + 30);
    // stationCount, not a sum of `counts` - `counts` now counts per-fuel-type
    // readings (up to 3 per station, see MapView.vue's currentSummary) when
    // no specific fuel type is picked, so summing it would overcount how
    // many actual stations that covers.
    ctx.fillText(`из ${stationCount} станций`, PADDING + 210, y + 54);
  }
  y += 90;

  // Map image, scaled to the card's content width while preserving its own
  // aspect ratio (whatever the on-screen map container happened to be),
  // capped at MAX_MAP_HEIGHT.
  let mapHeight = 0;
  if (mapCanvas) {
    const scale = contentWidth / mapCanvas.width;
    mapHeight = Math.min(MAX_MAP_HEIGHT, Math.round(mapCanvas.height * scale));
    if (draw) {
      ctx.save();
      roundRect(ctx, PADDING, y, contentWidth, mapHeight, 14);
      ctx.clip();
      // Centered crop if the height got capped, rather than squashing the
      // image out of proportion.
      const drawnSourceHeight = Math.min(mapCanvas.height, mapHeight / scale);
      const sy = (mapCanvas.height - drawnSourceHeight) / 2;
      ctx.drawImage(
        mapCanvas,
        0,
        sy,
        mapCanvas.width,
        drawnSourceHeight,
        PADDING,
        y,
        contentWidth,
        mapHeight
      );
      ctx.restore();
      ctx.strokeStyle = '#e5e7eb';
      ctx.lineWidth = 1;
      roundRect(ctx, PADDING + 0.5, y + 0.5, contentWidth - 1, mapHeight - 1, 14);
      ctx.stroke();
    }
    y += mapHeight + 36;
  }

  // Status breakdown tiles - same 4-tile row style as the region report
  // card's KPI row, but showing raw counts per status instead of derived
  // KPIs, since that's what actually explains the headline percentage above.
  const tileGap = 20;
  const tileWidth = (contentWidth - tileGap * 3) / 4;
  const tileHeight = 96;
  if (draw) {
    STATUS_TILES.forEach((tile, i) => {
      const tx = PADDING + i * (tileWidth + tileGap);
      ctx.fillStyle = '#f8fafc';
      roundRect(ctx, tx, y, tileWidth, tileHeight, 14);
      ctx.fill();

      ctx.fillStyle = tile.color;
      ctx.font = '700 32px -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(counts[tile.key] ?? 0), tx + tileWidth / 2, y + 46);

      ctx.fillStyle = '#64748b';
      ctx.font = '17px -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.fillText(tile.label, tx + tileWidth / 2, y + 74);
      ctx.textAlign = 'left';
    });
  }
  y += tileHeight + 32;

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
    ctx.fillText(tsLabel, PADDING, footerY);
    ctx.font = '20px -apple-system, "Segoe UI", Roboto, sans-serif';
    const brand = 'tbenz.in';
    const brandWidth = ctx.measureText(brand).width;
    ctx.fillText(brand, PADDING + contentWidth - brandWidth, footerY);
  }
  y += FOOTER_HEIGHT - 20;

  return Math.round(y);
}

/**
 * Draws a shareable "map snapshot" card - the current map view (tiles +
 * status-colored markers, already composited by the caller into
 * `mapCanvas`) plus a headline availability percentage and status-count
 * tiles for the current moment. Pure Canvas 2D, same measure-then-draw
 * two-pass approach as stationCard.js/regionReportCard.js, resolves with a
 * PNG Blob.
 */
export function renderMapShareCard({ regionName, mapCanvas, counts, stationCount, availablePct, generatedAt }) {
  const payload = { regionName, mapCanvas, counts, stationCount, availablePct, generatedAt };

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
