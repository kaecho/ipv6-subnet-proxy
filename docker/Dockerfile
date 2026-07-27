FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine
# iproute2: BusyBox's `ip` cannot create sit devices or add `local` routes,
# both of which the 6in4 tunnel bring-up needs.
# wireguard-tools: `wg`, used to configure the Cloudflare WARP links.
RUN apk add --no-cache tini iproute2 wireguard-tools
WORKDIR /app
COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/node_modules/ ./node_modules/
COPY --from=builder /app/package.json ./
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
RUN mkdir -p /data
VOLUME /data
EXPOSE 1080 3000
ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
