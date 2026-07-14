import {
  statusMeta,
  fuelTypeLabel,
  bestFuelStatus,
  CORE_FUEL_TYPES,
  computeStatusSegments,
  collapseIsolatedBlips,
} from './fuelStatus';
import { availabilityColor, formatPct, formatMinutes } from './colorScale';
import { roundRect, wrapText, renderCard } from './canvasDraw';

const WIDTH = 1000;
const PADDING = 56;
const FOOTER_HEIGHT = 90;

function formatDateTime(value) {
  if (!value) return '';
  return new Date(value).toLocaleString('ru-RU');
}

function formatHour(value) {
  if (!value) return '';
  return new Date(value).toLocaleString('ru-RU', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
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
  // StationReliabilityTimeline.vue - one row per core fuel type, each drawn
  // from real segments (not bucketed/downsampled - see fuelStatus.js's
  // computeStatusSegments/collapseIsolatedBlips) as a proportional-width
  // bar. Replaces two things this card used to draw separately: the old
  // "Последние отключения" bar list (this ribbon already shows exactly
  // when/how long each outage was, at a glance) and the old "История по
  // видам топлива" section (downsampleEvenly'd to ~40 points regardless of
  // how much real history existed, one crude strip per type) - same
  // underlying data, one real view instead of two approximate ones.
  if (history?.length) {
    if (draw) {
      ctx.fillStyle = '#0f172a';
      ctx.font = '600 28px -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.fillText('Лента статусов за 7 дней', PADDING, y);
    }
    y += 24;

    const rangeStart = new Date(history[0].polledAt).getTime();
    const rangeEnd = new Date(history[history.length - 1].polledAt).getTime();
    const totalMs = Math.max(1, rangeEnd - rangeStart);
    const rowHeight = 24;
    const rowGap = 8;
    const rowLabelWidth = 70;
    const barAreaWidth = contentWidth - rowLabelWidth;

    for (const fuelType of CORE_FUEL_TYPES) {
      const rowSegments = collapseIsolatedBlips(computeStatusSegments(history, [fuelType]));
      if (draw) {
        ctx.fillStyle = '#0f172a';
        ctx.font = '600 20px -apple-system, "Segoe UI", Roboto, sans-serif';
        ctx.fillText(fuelTypeLabel(fuelType), PADDING, y + rowHeight - 6);

        ctx.save();
        roundRect(ctx, PADDING + rowLabelWidth, y, barAreaWidth, rowHeight, 5);
        ctx.clip();
        let sx = PADDING + rowLabelWidth;
        for (const seg of rowSegments) {
          const segWidth = ((new Date(seg.end).getTime() - new Date(seg.start).getTime()) / totalMs) * barAreaWidth;
          ctx.fillStyle = statusMeta(seg.status).color;
          ctx.fillRect(sx, y, Math.max(segWidth, 0.5), rowHeight);
          sx += segWidth;
        }
        ctx.restore();
      }
      y += rowHeight + rowGap;
    }
    y += 14;

    // Day-boundary tick labels for orientation, same approach as the live
    // ribbon - positioned by percentage along the range, not tied to
    // segment edges (segments follow real poll timestamps, not midnight).
    if (draw) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '18px -apple-system, "Segoe UI", Roboto, sans-serif';
      const d = new Date(rangeStart);
      d.setHours(24, 0, 0, 0);
      while (d.getTime() < rangeEnd) {
        const tx = PADDING + rowLabelWidth + ((d.getTime() - rangeStart) / totalMs) * barAreaWidth;
        const label = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
        const labelWidth = ctx.measureText(label).width;
        const clampedX = Math.min(
          Math.max(tx - labelWidth / 2, PADDING + rowLabelWidth),
          PADDING + contentWidth - labelWidth
        );
        ctx.fillText(label, clampedX, y);
        d.setDate(d.getDate() + 1);
      }
    }
    y += 36;
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
