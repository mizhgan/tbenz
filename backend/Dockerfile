# Debian, not Alpine: Playwright's Chromium builds are glibc-only and aren't
# officially supported on musl/Alpine (see browserFetchService.js's doc
# comment for why a headless browser is needed at all - sberazs.ru's
# anti-bot JS challenge can't be solved with a plain HTTP client). This
# makes the image noticeably bigger than the old Alpine one; that's the
# accepted trade-off for the supported install path instead of an
# `apk add chromium` + manual executablePath workaround.
FROM node:20-bookworm-slim

WORKDIR /app

# fontconfig + a Cyrillic-capable font: needed for the Telegram digest cards
# (SVG rendered to PNG via sharp/librsvg) to actually show any text at all -
# without a font installed, librsvg silently renders text as empty/tofu.
RUN apt-get update && apt-get install -y --no-install-recommends fontconfig fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev
# Chromium binary + its OS-level shared library deps (--with-deps runs the
# apt-get install for those under the hood) - only chromium, not the
# webkit/firefox builds npm ci also pulled manifests for, to keep the image
# from growing any more than this already does.
RUN npx playwright install --with-deps chromium

COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "src/index.js"]
