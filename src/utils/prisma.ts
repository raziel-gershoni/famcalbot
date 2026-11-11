/**
 * Prisma Client Singleton (Prisma 7: queries go through the pg driver adapter on the pooled DATABASE_URL;
 * the client and its pool are built by createPrismaClient, src/utils/prisma-client.ts)
 */

import type { PrismaClient } from '@prisma/client';
import { createPrismaClient } from './prisma-client';

declare global {
  var prisma: PrismaClient | undefined;
}

export const prisma =
  global.prisma ||
  createPrismaClient(process.env.DATABASE_URL, process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error']);

if (process.env.NODE_ENV !== 'production') {
  global.prisma = prisma;
}

export { withRetry } from './db-retry';
