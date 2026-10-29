FROM node:22-alpine

WORKDIR /app
COPY server.mjs package.json ./
COPY bin ./bin

ENV HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787

CMD ["node", "server.mjs"]
