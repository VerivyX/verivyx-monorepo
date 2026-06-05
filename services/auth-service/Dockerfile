# ---- build (needs devDependencies: @types/node, @types/express, etc.) ----
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
COPY prisma ./prisma
RUN npm ci
RUN npx prisma generate
COPY *.ts ./
RUN npx tsc

# ---- runtime (prisma is now in dependencies, so --omit=dev keeps it) ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate
COPY --from=builder /app/dist ./dist
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 8083
ENTRYPOINT ["./entrypoint.sh"]
