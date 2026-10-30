FROM node:22-alpine

WORKDIR /app
COPY server.mjs package.json ./
COPY bin ./bin

# Localhost-only by default. For LAN use: -e HOST=0.0.0.0 -e BRIDGE_API_KEY=...
ENV HOST=127.0.0.1
ENV PORT=8787
EXPOSE 8787

CMD ["node", "server.mjs"]
