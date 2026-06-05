-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "stellar_address" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "pricePerRequest" DOUBLE PRECISION NOT NULL DEFAULT 0.005,
    "paywallEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Content" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'text/html',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Content_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "agent" TEXT,
    "category" TEXT,
    "amountUsdc" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sessionId" TEXT,
    "txHash" TEXT,
    "ip" TEXT,
    "powDurationMs" INTEGER,
    "ja4" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateUniqueIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_domain_key" ON "User"("domain");
CREATE UNIQUE INDEX "Content_userId_slug_key" ON "Content"("userId", "slug");

-- CreateIndex
CREATE INDEX "Content_userId_idx" ON "Content"("userId");
CREATE INDEX "Event_userId_createdAt_idx" ON "Event"("userId", "createdAt");
CREATE INDEX "Event_userId_agent_idx" ON "Event"("userId", "agent");

-- AddForeignKey
ALTER TABLE "Content" ADD CONSTRAINT "Content_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Event" ADD CONSTRAINT "Event_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
