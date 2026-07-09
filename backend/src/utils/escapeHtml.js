// Deliberately dependency-free (no other requires) - this used to live only
// inside telegramNotifier.js, and telegramSettingsMenu.js importing it from
// there created a require cycle (telegramBot.js -> telegramSettingsMenu.js
// -> telegramNotifier.js -> telegramBot.js, closed by ingestService.js
// requiring telegramNotifier.js before telegramBot.js is ever touched
// elsewhere in the app). Depending on exactly which file the app happens to
// require first, that cycle could silently hand one side an incomplete,
// still-loading module whose named export hadn't been assigned yet -
// `escapeHtml` would be `undefined` there without any error at require time,
// only a TypeError the first time the menu tried to actually call it
// (caught by bot.catch() and only logged, so the user just saw the bot go
// silent). Standing this function alone with zero imports makes it
// impossible for it to ever be part of a require cycle again, regardless of
// which module reaches for it first.
function escapeHtml(value) {
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
        return '&#39;';
    }
  });
}

module.exports = { escapeHtml };
