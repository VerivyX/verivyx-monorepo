FROM node:20-alpine

WORKDIR /app

# Install dependencies (tsx is a runtime dep — we run TS directly, no build step).
COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

EXPOSE 8087
CMD ["npm", "start"]
