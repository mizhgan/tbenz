/**
 * Renders the small map+stats image attached to stationAvailable/
 * stationUnavailable Telegram alerts, for chats with an admin-picked
 * alertMapBbox (see TelegramChat.js's doc comment on that field -
 * deliberately a smaller sub-area than the followed region's own bbox, so
 * markers stay legible instead of shrinking across a whole region).
 *
 * Two pieces composited into one PNG via sharp:
 *  - the map itself: a real Leaflet map (same OSM tiles/marker styling as
 *    the site's own map) rendered by loading a small self-contained HTML
 *    page into the shared headless browser (see browserFetchService.js -
 *    already kept alive for sberazs fetches, reused here rather than
 *    launching a second Chromium) and screenshotting it - not hand-rolled
 *    tile-compositing math, so it stays visually identical to the site's
 *    own map for free.
 *  - a stats strip below it (current %, status counts) - plain SVG+sharp,
 *    same technique and color palette as telegramDigestImage.js's digest
 *    card, for one consistent look across every image the bot posts.
 */
const sharp = require('sharp');
const browserFetchService = require('./browserFetchService');
const { deriveCoreStatus, MAYBE_AVAILABLE_WEIGHT } = require('./metricsService');
const logger = require('../utils/logger');
const {
  FONT,
  COLOR_BG,
  COLOR_GOOD,
  COLOR_WARN,
  COLOR_BAD,
  COLOR_MUTED,
  COLOR_TEXT,
  COLOR_SUBTEXT,
  pctColor: pctColorFor,
  escapeXml,
} = require('./telegramImageStyle');

const MAP_WIDTH = 640;
const MAP_HEIGHT = 400;
const STRIP_HEIGHT = 84;
const PAD = 24;

const STATUS_COLORS = {
  available: COLOR_GOOD,
  maybe_available: COLOR_WARN,
  not_available: COLOR_BAD,
  no_data: COLOR_MUTED,
};

// Leaflet/tiles loaded from unpkg's CDN rather than bundled - this only
// runs occasionally (a fuel-availability change, not every request), so
// the extra network round-trip isn't worth vendoring a copy of Leaflet
// into the backend image for.
function buildMapHtml(points, bbox) {
  // Own JSON escaping of "<" (not just relying on it never appearing) -
  // these are real station coordinates/colors, not user text, but a stray
  // "</script>"-shaped substring in a future data source's response should
  // never be able to break out of this inline script.
  const pointsJson = JSON.stringify(points).replace(/</g, '\\u003c');
  const boundsJson = JSON.stringify([
    [bbox.minLat, bbox.minLon],
    [bbox.maxLat, bbox.maxLon],
  ]);

  return `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<style>html,body,#map{margin:0;padding:0;width:${MAP_WIDTH}px;height:${MAP_HEIGHT}px;background:#e5e7eb;}</style>
</head><body>
<div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  const map = L.map('map', { zoomControl: false, attributionControl: true });
  // Same as the site's own maps (MapView.vue etc.): drop Leaflet's own
  // "Leaflet" branding link, keep the OpenStreetMap credit - required by
  // OSM's tile usage policy for their free tiles, unlike the Leaflet prefix.
  map.attributionControl.setPrefix(false);
  const tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(map);
  for (const p of ${pointsJson}) {
    L.circleMarker([p.lat, p.lon], {
      radius: 8, color: '#ffffff', weight: 2, fillColor: p.color, fillOpacity: 1,
    }).addTo(map);
  }
  window.__mapReady__ = false;
  tileLayer.on('load', () => { window.__mapReady__ = true; });
  map.fitBounds(${boundsJson}, { padding: [20, 20] });
</script>
</body></html>`;
}

/**
 * Screenshots the Leaflet map (tiles + colored station dots) for one
 * bbox, using the shared browser from browserFetchService.js. Falls
 * through to whatever's rendered so far (not a hard failure) if tiles
 * haven't finished loading within the timeout - a mostly-loaded map beats
 * no image at all for what's a best-effort notification attachment.
 */
async function captureMapImage(bbox, points) {
  const browser = await browserFetchService.getBrowser();
  const context = await browser.newContext({ viewport: { width: MAP_WIDTH, height: MAP_HEIGHT } });
  try {
    const page = await context.newPage();
    await page.setContent(buildMapHtml(points, bbox), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__mapReady__ === true, { timeout: 15000 }).catch(() => {
      logger.warn('telegramAlertMapImage: tiles did not finish loading in time, capturing anyway');
    });
    return await page.locator('#map').screenshot();
  } finally {
    await context.close().catch(() => {});
  }
}

// Plain colored dot, not an emoji glyph - same reasoning as
// telegramDigestImage.js's statChip (color-emoji fonts aren't reliably
// present in a headless rendering environment).
function statChip(x, y, dotColor, count, label) {
  return `
    <circle cx="${x + 7}" cy="${y - 7}" r="7" fill="${dotColor}"/>
    <text x="${x + 22}" y="${y}" font-family="${FONT}" font-size="20" font-weight="bold" fill="${COLOR_TEXT}">${count}</text>
    <text x="${x}" y="${y + 18}" font-family="${FONT}" font-size="11" fill="${COLOR_SUBTEXT}">${escapeXml(label)}</text>
  `;
}

// Same "available + MAYBE_AVAILABLE_WEIGHT*maybe_available over
// available + maybe_available + not_available" definition MapView.vue's
// currentSummary and telegramDigestData's currentPct use - no_data is
// excluded from the denominator (it's "we don't know", not "it's not
// there"). Each station's
// own coreStatus (best-of among gasoline - see metricsService.deriveCoreStatus)
// is what's counted here, not lastStatus (blanket overall status) - same
// "gasoline is the real shortage, not diesel/gas" call as everywhere else.
// `stations` here is renderAlertMapImage's statsStations - the chat's whole
// region, not the bbox-scoped set the map above draws dots for.
async function renderStatsStrip(stations) {
  const counts = { available: 0, maybe_available: 0, not_available: 0, no_data: 0 };
  for (const s of stations) {
    const st = deriveCoreStatus(s.lastFuelStatuses);
    counts[st] = (counts[st] || 0) + 1;
  }
  const known = counts.available + counts.maybe_available + counts.not_available;
  const pct =
    known > 0
      ? Math.round(((counts.available + MAYBE_AVAILABLE_WEIGHT * counts.maybe_available) / known) * 100)
      : null;
  const pctText = pct === null ? '—' : `${pct}%`;
  const color = pctColorFor(pct);

  const chipsStartX = PAD + 130;
  const colWidth = (MAP_WIDTH - PAD - chipsStartX) / 4;
  const chips = [
    [COLOR_GOOD, counts.available, 'есть'],
    [COLOR_WARN, counts.maybe_available, 'частично'],
    [COLOR_BAD, counts.not_available, 'нет'],
    [COLOR_MUTED, counts.no_data, 'нет данных'],
  ]
    .map(([dotColor, count, label], i) => statChip(chipsStartX + i * colWidth, STRIP_HEIGHT / 2 + 6, dotColor, count, label))
    .join('');

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${MAP_WIDTH}" height="${STRIP_HEIGHT}">
      <rect width="${MAP_WIDTH}" height="${STRIP_HEIGHT}" fill="${COLOR_BG}"/>
      <text x="${PAD}" y="${STRIP_HEIGHT / 2 + 12}" font-family="${FONT}" font-size="36" font-weight="bold" fill="${color}">${pctText}</text>
      <text x="${PAD}" y="${STRIP_HEIGHT - 12}" font-family="${FONT}" font-size="11" fill="${COLOR_SUBTEXT}">доступно сейчас · АИ-92, АИ-95</text>
      ${chips}
      <text x="${MAP_WIDTH - PAD}" y="${STRIP_HEIGHT - 10}" font-family="${FONT}" font-size="10" fill="${COLOR_MUTED}" text-anchor="end">tbenz.in</text>
    </svg>
  `;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Renders the full alert map image: Leaflet screenshot of `bbox` (with a
 * colored dot per station in `stations`, keyed by each station's own
 * coreStatus - best-of among gasoline, see metricsService.deriveCoreStatus,
 * not the blanket `lastStatus`) stacked above a stats strip. Returns a PNG
 * Buffer, ready for telegramBot.sendPhoto.
 *
 * `stations` (bbox-scoped, picked by the admin purely so markers on this
 * small image stay legible - see TelegramChat.js's alertMapBbox doc
 * comment) only drives the *dots*. `statsStations` drives the strip's
 * numbers and should be the chat's whole followed region, same set the
 * site's own map/report cards use - reported by a user comparing this
 * image against the site's share card: the strip used to summarize only
 * the bbox-scoped `stations`, so a bbox covering e.g. 77 of a region's 101
 * stations produced a strip whose numbers (and their sum) never matched
 * the site at all, with nothing on the image explaining why. Falls back to
 * `stations` if `statsStations` isn't given (keeps callers optional).
 *
 * `visibleStatuses` (optional Set/array of status keys) only thins out
 * which stations get a *dot* - e.g. a chat that's mostly not_available
 * stations can drop that status from the map so the few
 * available/maybe_available ones aren't lost in a sea of red. Doesn't
 * touch the stats strip either, for the same "showing 0 нет under a map
 * that hid 40 red dots reads as a wrong claim about supply" reason as
 * before.
 */
async function renderAlertMapImage({ bbox, stations, statsStations, visibleStatuses }) {
  const allowed = visibleStatuses ? new Set(visibleStatuses) : null;
  const points = stations
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon))
    .map((s) => ({ ...s, coreStatus: deriveCoreStatus(s.lastFuelStatuses) }))
    .filter((s) => !allowed || allowed.has(s.coreStatus))
    .map((s) => ({ lat: s.lat, lon: s.lon, color: STATUS_COLORS[s.coreStatus] || STATUS_COLORS.no_data }));

  const [mapBuffer, statsBuffer] = await Promise.all([
    captureMapImage(bbox, points),
    renderStatsStrip(statsStations || stations),
  ]);

  return sharp({
    create: { width: MAP_WIDTH, height: MAP_HEIGHT + STRIP_HEIGHT, channels: 3, background: COLOR_BG },
  })
    .composite([
      { input: mapBuffer, top: 0, left: 0 },
      { input: statsBuffer, top: MAP_HEIGHT, left: 0 },
    ])
    .png()
    .toBuffer();
}

module.exports = { renderAlertMapImage };
