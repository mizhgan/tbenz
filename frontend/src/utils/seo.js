const SITE_URL = 'https://tbenz.in';

// Creates the tag on first call, then just updates its content - avoids
// piling up duplicate <meta>/<link> tags on every navigation (this runs on
// every route change, not just once at boot).
function upsertTag(selector, tagName, attrs) {
  let el = document.querySelector(selector);
  if (!el) {
    el = document.createElement(tagName);
    for (const [key, value] of Object.entries(attrs)) {
      if (key !== 'content' && key !== 'href') el.setAttribute(key, value);
    }
    document.head.appendChild(el);
  }
  if ('content' in attrs) el.setAttribute('content', attrs.content);
  if ('href' in attrs) el.setAttribute('href', attrs.href);
}

// Called from router.afterEach (see router/index.js) so every route gets
// its own title/description/canonical instead of the one static set baked
// into index.html - a search result or shared link for /reports shouldn't
// read "Карта АЗС..." just because that's whatever index.html said at
// build time. `path` builds the canonical/og:url; `robots` defaults to
// indexable and is overridden to 'noindex, nofollow' for admin-only and
// utility routes (see each route's own `meta.seo` in router/index.js).
export function applySeo({ title, description, path, robots = 'index, follow' }) {
  if (title) {
    document.title = title;
    upsertTag('meta[property="og:title"]', 'meta', { property: 'og:title', content: title });
    upsertTag('meta[name="twitter:title"]', 'meta', { name: 'twitter:title', content: title });
  }

  if (description) {
    upsertTag('meta[name="description"]', 'meta', { name: 'description', content: description });
    upsertTag('meta[property="og:description"]', 'meta', { property: 'og:description', content: description });
    upsertTag('meta[name="twitter:description"]', 'meta', { name: 'twitter:description', content: description });
  }

  const url = `${SITE_URL}${path}`;
  upsertTag('link[rel="canonical"]', 'link', { rel: 'canonical', href: url });
  upsertTag('meta[property="og:url"]', 'meta', { property: 'og:url', content: url });

  upsertTag('meta[name="robots"]', 'meta', { name: 'robots', content: robots });
}
