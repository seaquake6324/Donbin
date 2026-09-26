FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/yt-dlp && /opt/yt-dlp/bin/pip install --no-cache-dir "yt-dlp[default]==2026.8.19"
ENV PATH="/opt/yt-dlp/bin:${PATH}"
WORKDIR /app
RUN npm install -g pnpm@11.19.0
COPY package.json pnpm-lock.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile
COPY src ./src
COPY public ./public
RUN pnpm run build
RUN mkdir -p /app/data && chown -R node:node /app
USER node
CMD ["node", "dist/index.js"]
