FROM node:20-alpine

WORKDIR /app

# Runtime deps only. tsx is a runtime dependency — we execute TypeScript directly
# (no build step), consistent with the other Node services in this repo.
COPY package*.json ./
RUN npm install --omit=dev

# App code + vendored x402 Stellar core (src/core/stellar)
COPY tsconfig.json ./
COPY src ./src

EXPOSE 8088
CMD ["npm", "start"]
