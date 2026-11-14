import { Prisma } from "@roadland/database";
import { UnauthorizedException } from "@nestjs/common";

/** A DB lock outlives the Redis lease and serializes all mutations of each wallet. */
export async function lockVehicles(tx: Prisma.TransactionClient, ids: string[]) {
  const sorted = [...new Set(ids)].sort();
  const rows = await tx.$queryRaw<{id: string}[]>`
    SELECT id FROM vehicles WHERE id IN (${Prisma.join(sorted)}) ORDER BY id FOR UPDATE`;
  if (rows.length !== sorted.length) throw new UnauthorizedException("등록되지 않은 차량이에요");
}
