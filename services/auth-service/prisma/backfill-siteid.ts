// One-off, idempotent backfill: assigns a unique siteId to every User that
// still has siteId = NULL. Safe to run multiple times — rows that already have
// a siteId are never touched. Run once after `prisma db push` adds the column.
//
//   npx tsx prisma/backfill-siteid.ts
//
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const pending = await prisma.user.findMany({
    where: { siteId: null },
    select: { id: true },
  });

  let updated = 0;
  for (const { id } of pending) {
    const siteId = 'site_' + randomBytes(12).toString('hex');
    await prisma.user.update({ where: { id }, data: { siteId } });
    updated += 1;
  }

  console.log(`backfill-siteid: assigned siteId to ${updated} user(s) (of ${pending.length} with null siteId)`);
}

main()
  .catch((err) => {
    console.error('backfill-siteid: failed', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
