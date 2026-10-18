# ---------- web UI ----------
FROM node:22-trixie-slim AS web
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---------- server dependencies ----------
FROM node:22-trixie-slim AS deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---------- runtime ----------
FROM node:22-trixie-slim
ARG TARGETARCH

# FFmpeg 7.1 from Debian (VAAPI, NVENC/CUDA, libzimg tone mapping) + GPU drivers for Intel/AMD.
# tini reaps ffmpeg children so stopped transcodes never linger as zombies.
RUN sed -i 's/^Components: main$/Components: main contrib non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg tini ca-certificates mesa-va-drivers vainfo \
      $( [ "$TARGETARCH" = "amd64" ] && echo "intel-media-va-driver-non-free i965-va-driver" ) \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY server/ ./server/
COPY --from=web /build/web/dist ./web/dist

ENV NODE_ENV=production \
    PORT=8420 \
    CONFIG_DIR=/config \
    TRANSCODE_DIR=/transcode \
    MEDIA_ROOTS=/media \
    WEB_DIR=/app/web/dist \
    LIBVA_DRIVERS_PATH=/usr/lib/x86_64-linux-gnu/dri:/usr/lib/aarch64-linux-gnu/dri \
    NVIDIA_DRIVER_CAPABILITIES=compute,video,utility

RUN mkdir -p /config /transcode /media && chown -R node:node /config /transcode

USER node
EXPOSE 8420
VOLUME ["/config"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8420)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/index.js"]
