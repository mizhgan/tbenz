/**
 * Rotating copy for the once-a-day promotional post (see
 * telegramPromoScheduler.js / telegramNotifier.sendPromoPost) - a handful
 * of different phrasings that all carry the same core: what the tool does,
 * a link to the live map, and a link to the bot for personal notifications.
 * Picking a different variant each day is purely for feed variety (the
 * same exact wording every day reads as spam/bot-generated); the
 * underlying pitch never actually changes between them.
 */
const SITE_URL = 'https://tbenz.in';
const BOT_USERNAME = '@tbenz_bot';

const VARIANTS = [
  `⛽ <b>Топливо есть — или нет?</b> Узнайте за секунду.

Каждые 15 минут сверяем несколько независимых источников и показываем честный статус по каждой заправке и виду топлива — 92, 95, ДТ, газ.

🗺 Карта: ${SITE_URL}
🔔 Уведомления под свой район: ${BOT_USERNAME}`,

  `Опять стоите в очереди на заправке, где на самом деле пусто? 😩

Мы отслеживаем наличие топлива в реальном времени, без регистрации — прямо с телефона.

🗺 ${SITE_URL}
🔔 Бот с уведомлениями: ${BOT_USERNAME} — настройте свой район и виды топлива под себя.`,

  `Как это работает 👇

Мы не спрашиваем «есть бензин?» у одного сайта и не гадаем. Сверяем несколько независимых источников — если они сходятся, показываем «есть» зелёным, если расходятся — честно «возможно есть», а не врём.

🗺 Живая карта: ${SITE_URL}
🔔 Настроить бота под себя: ${BOT_USERNAME}`,

  `📍 На заправках рядом с вами — прямо сейчас, на карте, без регистрации.

🗺 ${SITE_URL}
🔔 Хотите узнавать первыми, когда топливо появляется или пропадает? ${BOT_USERNAME} — команда /settings`,
];

function randomPromoText() {
  return VARIANTS[Math.floor(Math.random() * VARIANTS.length)];
}

module.exports = { randomPromoText };
