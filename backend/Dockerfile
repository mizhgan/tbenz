FROM node:20-alpine

WORKDIR /app

# fontconfig + a Cyrillic-capable font: needed for the Telegram digest cards
# (SVG rendered to PNG via sharp/librsvg) to actually show any text at all -
# without a font installed, librsvg silently renders text as empty/tofu.
RUN apk add --no-cache fontconfig ttf-dejavu

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "src/index.js"]
