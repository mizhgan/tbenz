/**
 * Fetches a JSON API endpoint through a real (headless) Chromium browser
 * instead of a plain HTTP client - the only thing that gets past sberazs.ru's
 * anti-bot protection (see sberazsClient.js's doc comment). Confirmed live:
 * a direct request (even with a browser-shaped User-Agent, through or
 * without a proxy) always gets served a JS-challenge page instead of the
 * real response - a small, deterministic proof-of-work script that computes
 * a hash, sets two cookies (`__jhash_`/`__jua_`), and reloads the page via
 * `window.location.href` about a second later. A real browser executes that
 * script automatically; nothing about it is sberazs-specific enough to be
 * worth reverse-engineering into a plain HTTP client instead (and it could
 * change at any time) - actually running it is both simpler and more
 * durable.
 *
 * One Chromium instance is launched lazily on first use and kept alive for
 * the process's lifetime (launching a fresh browser per request would cost
 * several hundred ms every poll for no benefit) - each fetch gets its own
 * short-lived browser *context* instead (cheap by comparison), so concurrent
 * fetches (different regions/proxies) don't share cookies/state with each
 * other.
 */
const { chromium } = require('playwright');
const logger = require('../utils/logger');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

let browserPromise = null;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true }).catch((err) => {
      browserPromise = null; // let the next call retry instead of caching a permanent failure
      throw err;
    });
  }
  return browserPromise;
}

function looksLikeJson(text) {
  const trimmed = text.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

/**
 * Navigates to `url` and returns its response body parsed as JSON. If the
 * first load isn't JSON (the anti-bot challenge page, distinguishable in
 * practice by having no visible body text at all), waits for the page's own
 * script-triggered reload and reads the body again - that second load is
 * the real response, now that the challenge cookies are set.
 *
 * `proxy` is an optional Playwright context proxy option (see
 * proxyService.buildPlaywrightProxyOption) - each context gets its own, so
 * different fetches can go through different (or no) proxies concurrently
 * on the one shared browser.
 */
async function fetchJsonThroughBrowser(url, { proxy, timeoutMs = 20000, ignoreHTTPSErrors = false } = {}) {
  const browser = await getBrowser();
  const context = await browser.newContext({ userAgent: USER_AGENT, proxy, ignoreHTTPSErrors });
  const deadline = Date.now() + timeoutMs;
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    let text = await page.evaluate(() => document.body.innerText);

    if (!looksLikeJson(text)) {
      const remaining = Math.max(1000, deadline - Date.now());
      // The challenge's own reload - if this never fires (page genuinely
      // has nothing else to show us), fall through and let the empty/non-
      // JSON body below raise the real error instead of hanging out here.
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: remaining }).catch(() => {});
      text = await page.evaluate(() => document.body.innerText);
    }

    if (!looksLikeJson(text)) {
      throw new Error('Browser fetch returned a non-JSON response (challenge not resolved in time)');
    }
    return JSON.parse(text);
  } finally {
    await context.close().catch((err) => logger.warn(`browserFetchService: context close failed: ${err.message}`));
  }
}

async function closeBrowser() {
  if (!browserPromise) return;
  const promise = browserPromise;
  browserPromise = null;
  try {
    const browser = await promise;
    await browser.close();
  } catch (err) {
    logger.warn(`browserFetchService: browser close failed: ${err.message}`);
  }
}

module.exports = { getBrowser, fetchJsonThroughBrowser, closeBrowser };
