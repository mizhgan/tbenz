// Shared color palette, font and small SVG helpers for the bot's two SVG-
// based image renderers (telegramDigestImage.js, telegramAlertMapImage.js -
// the map-tile screenshot in the latter is composited separately, this only
// covers the SVG parts). Both used to hand-roll identical copies of these;
// COLOR_MUTED had already drifted between them (#64748b vs #9ca3af) before
// this was factored out - #64748b is kept here since the palette otherwise
// grades consistently darker-to-lighter (BORDER < MUTED < SUBTEXT < TEXT).
const FONT = 'DejaVu Sans, Arial, sans-serif';

const COLOR_BG = '#0f172a';
const COLOR_BORDER = '#1e293b';
const COLOR_GOOD = '#16a34a';
const COLOR_WARN = '#d97706';
const COLOR_BAD = '#dc2626';
const COLOR_MUTED = '#64748b';
const COLOR_TEXT = '#f1f5f9';
const COLOR_SUBTEXT = '#94a3b8';

// Availability-percentage color scale used for the big headline number in
// both renderers - null (no known data yet) reads as muted, not as bad.
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

module.exports = {
  FONT,
  COLOR_BG,
  COLOR_BORDER,
  COLOR_GOOD,
  COLOR_WARN,
  COLOR_BAD,
  COLOR_MUTED,
  COLOR_TEXT,
  COLOR_SUBTEXT,
  pctColor,
  escapeXml,
};
