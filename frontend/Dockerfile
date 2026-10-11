FROM node:20-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# next/image guarda las imágenes optimizadas en .next/cache: tiene que poder
# escribir ahí el usuario sin privilegios, o las re-optimiza en cada pedido.
RUN adduser --disabled-password --gecos "" appuser \
    && mkdir -p .next/cache \
    && chown appuser .next/cache
USER appuser

EXPOSE 3000
CMD ["node", "server.js"]
