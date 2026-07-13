// Small Canvas 2D drawing primitives shared between the shareable station
// card and the shareable region report card - kept separate from either
// card's own layout code since both need exactly the same two helpers.

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Shared measure-then-draw runner for the three shareable-card renderers
// (mapShareCard.js/stationCard.js/regionReportCard.js): each card's own
// `layoutCard(ctx, payload, draw)` returns its measured content height, then
// - unchanged from that first pass - actually paints onto a canvas sized to
// exactly that height, with the same '#f4f6f8' page background + white
// rounded card underneath every card shares. `layoutFn` must be that card's
// own layoutCard (or equivalent) function.
export function renderCard(layoutFn, payload, { width = 1000 } = {}) {
  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');
  const height = layoutFn(measureCtx, payload, false);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#f4f6f8';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, 24, 24, width - 48, height - 48, 24);
  ctx.fill();

  layoutFn(ctx, payload, true);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Не удалось создать изображение'));
    }, 'image/png');
  });
}

export function wrapText(ctx, text, maxWidth) {
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
