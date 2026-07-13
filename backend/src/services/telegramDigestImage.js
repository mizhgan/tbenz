const sharp = require('sharp');

const WIDTH = 640;
const HEIGHT = 340;
const PAD = 32;
const FONT = 'DejaVu Sans, Arial, sans-serif';

const COLOR_BG = '#0f172a';
const COLOR_BORDER = '#1e293b';
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

// deltaText/suffixText are always kept as two separate, independently short
// strings (never a single string spliced apart later) - a previous version
// built one combined string and tried to split it back into two lines by
// searching for " к " in it, which broke the moment the "no comparison
// data yet" message (which doesn't contain that substring at all) hit the
// same code path, overflowing the badge past the card's edge.
function trendLabel(trend, deltaPct, periodLabel) {
  if (trend === 'unknown' || deltaPct === null) {
    return { arrow: '', deltaText: '', suffixText: 'нет данных', color: COLOR_SUBTEXT };
  }
  const meta = TREND_META[trend] || TREND_META.unknown;
  const sign = deltaPct > 0 ? '+' : '';
  return { arrow: meta.arrow, deltaText: `${sign}${deltaPct.toFixed(0)}%`, suffixText: `к ${periodLabel}`, color: meta.color };
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

  const baseline = `<line x1="${x}" y1="${y + height}" x2="${x + width}" y2="${y + height}" stroke="${COLOR_BORDER}" stroke-width="1"/>`;
  const shapes = segments
    .filter((seg) => seg.length > 1)
    .map((seg) => {
      const linePoints = seg.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
      const first = seg[0];
      const last = seg[seg.length - 1];
      // A soft fill under the line gives the sparkline visual weight at
      // small sizes, instead of a thin stroke that's easy to miss.
      const areaPoints = `${first.x.toFixed(1)},${(y + height).toFixed(1)} ${linePoints} ${last.x.toFixed(1)},${(y + height).toFixed(1)}`;
      return (
        `<polygon points="${areaPoints}" fill="${color}" fill-opacity="0.12"/>` +
        `<polyline points="${linePoints}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`
      );
    })
    .join('');

  return baseline + shapes;
}

// A plain colored dot, not an emoji glyph - color-emoji fonts (needed for
// 🟢/🟡/🔴/⚪ to render as anything but a black dot) aren't reliably present
// in a headless rendering environment, so this is drawn directly instead.
function statChip(x, y, dotColor, count, label) {
  return `
    <circle cx="${x + 7}" cy="${y - 7}" r="7" fill="${dotColor}"/>
    <text x="${x + 24}" y="${y}" font-family="${FONT}" font-size="22" font-weight="bold" fill="${COLOR_TEXT}">${count}</text>
    <text x="${x}" y="${y + 20}" font-family="${FONT}" font-size="12" fill="${COLOR_SUBTEXT}">${label}</text>
  `;
}

const TREND_BADGE_WIDTH = 250;
const TREND_BADGE_HEIGHT = 66;

// Badge for the trend, sized and placed to sit in the large empty area
// beside the big percentage rather than as a small top-corner label
// competing with the title for space. deltaText and suffixText are
// rendered independently (never split out of one combined string), so
// this works the same whether there's a delta to show or not.
function trendBadge(trendInfo, x, y) {
  const hasDelta = Boolean(trendInfo.deltaText);
  const suffixY = hasDelta ? y + 46 : y + (TREND_BADGE_HEIGHT / 2 + 6);
  return `
    <rect x="${x}" y="${y}" width="${TREND_BADGE_WIDTH}" height="${TREND_BADGE_HEIGHT}" rx="12" fill="${trendInfo.color}" fill-opacity="0.14"/>
    ${trendInfo.arrow ? `<text x="${x + 22}" y="${y + 34}" font-family="${FONT}" font-size="26" fill="${trendInfo.color}">${trendInfo.arrow}</text>` : ''}
    ${hasDelta ? `<text x="${x + (trendInfo.arrow ? 56 : 22)}" y="${y + 35}" font-family="${FONT}" font-size="24" font-weight="bold" fill="${trendInfo.color}">${escapeXml(trendInfo.deltaText)}</text>` : ''}
    <text x="${x + 22}" y="${suffixY}" font-family="${FONT}" font-size="14" fill="${trendInfo.color}" fill-opacity="0.85">${escapeXml(trendInfo.suffixText)}</text>
  `;
}

// No real text-metrics available in server-side SVG, so this is a
// conservative fixed-width-per-character estimate for bold DejaVu Sans at
// font-size 23 - calibrated by actually rendering sample Cyrillic strings
// through sharp and measuring the trimmed output width (~14.5-19.7px/char
// depending on how many wide capital letters a string has); 18px/char
// covers that range with a small safety margin, at the cost of sometimes
// truncating a bit earlier than strictly necessary.
function truncateToWidth(text, maxWidth, avgCharWidth) {
  const maxChars = Math.max(1, Math.floor(maxWidth / avgCharWidth));
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

/**
 * Renders one region's digest card (current %, status breakdown, trend,
 * sparkline) as a PNG buffer via SVG + sharp. Kept deliberately compact -
 * anything that doesn't fit cleanly (per-station detail, exact numbers)
 * belongs in the accompanying text message, not crammed into the image.
 */
async function renderRegionDigestCard(data, { periodLabel, comparisonLabel }) {
  const { region, stationCounts, currentPct, trend, trendDeltaPct, series } = data;
  const color = pctColor(currentPct);
  const pctText = currentPct === null ? '—' : `${currentPct.toFixed(0)}%`;
  const trendInfo = trendLabel(trend, trendDeltaPct, comparisonLabel);

  const sparkline = sparklineSvg(series, PAD, 256, WIDTH - PAD * 2, 44, color);

  // Four equal-width columns rather than fixed pixel offsets - stays
  // readable even when a busy region pushes a count into 2-3 digits.
  // stationCounts (not the reading-pooled `counts` the percentage above is
  // built from) - one bucket per station, so these four numbers always sum
  // to the region's actual station count instead of ~2x it.
  const colWidth = (WIDTH - PAD * 2) / 4;
  const statRow = [
    [COLOR_GOOD, stationCounts.available, 'доступно'],
    [COLOR_WARN, stationCounts.maybe_available, 'частично'],
    [COLOR_BAD, stationCounts.not_available, 'нет'],
    [COLOR_MUTED, stationCounts.no_data, 'нет данных'],
  ]
    .map(([dotColor, count, label], i) => statChip(PAD + i * colWidth, 216, dotColor, count, label))
    .join('');

  // The title no longer shares its row with the trend badge (which now
  // sits beside the percentage instead), so it gets the full card width -
  // just a safety truncation for an unrealistically long region name.
  const titleText = truncateToWidth(region.name, WIDTH - PAD * 2, 18);

  // "100%" is the widest the percentage text can realistically get -
  // measured (not guessed) at ~195px, so the badge is anchored well clear
  // of it regardless of how many digits the current figure has.
  const badgeX = PAD + 210;
  const badgeY = 96;

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
      <rect width="${WIDTH}" height="${HEIGHT}" fill="${COLOR_BG}"/>
      <rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${HEIGHT - 1}" fill="none" stroke="${COLOR_BORDER}" stroke-width="1"/>

      <text x="${PAD}" y="44" font-family="${FONT}" font-size="23" font-weight="bold" fill="${COLOR_TEXT}">${escapeXml(titleText)}</text>
      <text x="${PAD}" y="66" font-family="${FONT}" font-size="13" fill="${COLOR_SUBTEXT}">${escapeXml(periodLabel)}</text>

      <text x="${PAD}" y="152" font-family="${FONT}" font-size="66" font-weight="bold" fill="${color}">${pctText}</text>
      <text x="${PAD}" y="174" font-family="${FONT}" font-size="14" fill="${COLOR_SUBTEXT}">доступность сейчас · АИ-92, АИ-95</text>
      ${trendBadge(trendInfo, badgeX, badgeY)}

      ${statRow}

      ${sparkline}
      <text x="${WIDTH - PAD}" y="${HEIGHT - 12}" font-family="${FONT}" font-size="11" fill="${COLOR_MUTED}" text-anchor="end">tbenz.in</text>
    </svg>
  `;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

module.exports = { renderRegionDigestCard, pctColor };
