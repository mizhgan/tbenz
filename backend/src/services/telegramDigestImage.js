const sharp = require('sharp');

const WIDTH = 640;
const HEIGHT = 320;
const PAD = 28;
const FONT = 'DejaVu Sans, Arial, sans-serif';

const COLOR_BG = '#0f172a';
const COLOR_CARD_BORDER = '#1e293b';
const COLOR_GOOD = '#16a34a';
const COLOR_WARN = '#d97706';
const COLOR_BAD = '#dc2626';
const COLOR_MUTED = '#64748b';
const COLOR_TEXT = '#f1f5f9';
const COLOR_SUBTEXT = '#94a3b8';

function pctColor(pct) {
  if (pct === null) return COLOR_MUTED;
  if (pct >= 85) return COLOR_GOOD;
  if (pct >= 60) return COLOR_WARN;
  return COLOR_BAD;
}

function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });
}

const TREND_META = {
  improving: { arrow: '↗', color: COLOR_GOOD },
  worsening: { arrow: '↘', color: COLOR_BAD },
  stable: { arrow: '→', color: COLOR_SUBTEXT },
  unknown: { arrow: '', color: COLOR_SUBTEXT },
};

function trendLabel(trend, deltaPct, periodLabel) {
  const meta = TREND_META[trend] || TREND_META.unknown;
  if (trend === 'unknown' || deltaPct === null) return { arrow: '', text: 'нет данных для сравнения', color: COLOR_SUBTEXT };
  const sign = deltaPct > 0 ? '+' : '';
  return { arrow: meta.arrow, text: `${sign}${deltaPct.toFixed(0)}% к ${periodLabel}`, color: meta.color };
}

// Combined "available-like" pct per sparkline bucket (available + maybe),
// or null for a bucket with no known data at all - drawn as a gap.
function bucketCombinedPct(bucket) {
  if (bucket.availablePct === null && bucket.maybeAvailablePct === null) return null;
  return (bucket.availablePct ?? 0) + (bucket.maybeAvailablePct ?? 0);
}

function sparklineSvg(series, x, y, width, height, color) {
  if (!series.length) return '';
  const step = width / Math.max(1, series.length - 1);
  const points = series.map((bucket, i) => {
    const pct = bucketCombinedPct(bucket);
    const py = pct === null ? null : y + height - (Math.max(0, Math.min(100, pct)) / 100) * height;
    return { x: x + i * step, y: py };
  });

  // Break the polyline into segments at gaps (buckets with no data) instead
  // of interpolating straight through them - a gap means "we don't know",
  // not "it was at 0%".
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

  const baseline = `<line x1="${x}" y1="${y + height}" x2="${x + width}" y2="${y + height}" stroke="${COLOR_CARD_BORDER}" stroke-width="1"/>`;
  const polylines = segments
    .filter((seg) => seg.length > 1)
    .map((seg) => {
      const d = seg.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
      return `<polyline points="${d}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
    })
    .join('');

  return baseline + polylines;
}

// A plain colored dot, not an emoji glyph - color-emoji fonts (needed for
// 🟢/🟡/🔴/⚪ to render as anything but a black dot) aren't reliably present
// in a headless rendering environment, so this is drawn directly instead.
function statChip(x, y, dotColor, count, label) {
  return `
    <circle cx="${x + 6}" cy="${y - 6}" r="6" fill="${dotColor}"/>
    <text x="${x + 22}" y="${y}" font-family="${FONT}" font-size="18" font-weight="bold" fill="${COLOR_TEXT}">${count}</text>
    <text x="${x + 22}" y="${y + 16}" font-family="${FONT}" font-size="11" fill="${COLOR_SUBTEXT}">${label}</text>
  `;
}

/**
 * Renders one region's digest card (current %, status breakdown, trend,
 * sparkline) as a PNG buffer via SVG + sharp. Kept deliberately compact -
 * anything that doesn't fit cleanly (per-station detail, exact numbers)
 * belongs in the accompanying text message, not crammed into the image.
 */
async function renderRegionDigestCard(data, { periodLabel, comparisonLabel }) {
  const { region, counts, currentPct, trend, trendDeltaPct, series } = data;
  const color = pctColor(currentPct);
  const pctText = currentPct === null ? '—' : `${currentPct.toFixed(0)}%`;
  const trendInfo = trendLabel(trend, trendDeltaPct, comparisonLabel);

  const sparkline = sparklineSvg(series, PAD, 240, WIDTH - PAD * 2, 46, color);

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
      <rect width="${WIDTH}" height="${HEIGHT}" rx="16" fill="${COLOR_BG}"/>
      <rect x="1" y="1" width="${WIDTH - 2}" height="${HEIGHT - 2}" rx="15" fill="none" stroke="${COLOR_CARD_BORDER}" stroke-width="2"/>

      <text x="${PAD}" y="46" font-family="${FONT}" font-size="24" font-weight="bold" fill="${COLOR_TEXT}">${escapeXml(region.name)}</text>
      <text x="${PAD}" y="68" font-family="${FONT}" font-size="14" fill="${COLOR_SUBTEXT}">${escapeXml(periodLabel)}</text>

      <text x="${PAD}" y="140" font-family="${FONT}" font-size="64" font-weight="bold" fill="${color}">${pctText}</text>
      <text x="${PAD}" y="162" font-family="${FONT}" font-size="14" fill="${COLOR_SUBTEXT}">доступность сейчас</text>
      <text x="${270}" y="128" font-family="${FONT}" font-size="20" fill="${trendInfo.color}">${trendInfo.arrow}</text>
      <text x="${270}" y="152" font-family="${FONT}" font-size="13" fill="${trendInfo.color}">${escapeXml(trendInfo.text)}</text>

      ${statChip(PAD, 200, COLOR_GOOD, counts.available, 'доступно')}
      ${statChip(PAD + 110, 200, COLOR_WARN, counts.maybe_available, 'частично')}
      ${statChip(PAD + 220, 200, COLOR_BAD, counts.not_available, 'нет')}
      ${statChip(PAD + 320, 200, COLOR_MUTED, counts.no_data, 'нет данных')}

      ${sparkline}
      <text x="${WIDTH - PAD}" y="${HEIGHT - 10}" font-family="${FONT}" font-size="11" fill="${COLOR_MUTED}" text-anchor="end">tbenz.in</text>
    </svg>
  `;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

module.exports = { renderRegionDigestCard, pctColor };
