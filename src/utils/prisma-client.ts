/**
 * The one place a database client is built (Prisma 7 with the pg driver adapter), for the app (src/utils/prisma.ts) and
 * the seed. Prisma 7 reads none of the old URL knobs (connection_limit, pool_timeout, connect_timeout): the pool takes
 * its settings here.
 */
import { PrismaClient, type Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { captureError } from '../lib/error-capture';

/**
 * - max 5: Prisma 5's default (2 x CPUs + 1) on Railway's 2 vCPUs. Each module instance that loads src/utils/prisma.ts in
 *   production builds its own client and pool (the scheduler and the routes), so the process holds a few times this.
 * - idleTimeoutMillis 60 s: an idle connection closes after a minute, long before Neon suspends (5 idle minutes), and a
 *   burst of requests still reuses its connections (pg's own default, 10 s, would reconnect for nearly every request).
 * - no connectionTimeoutMillis (pg's 0): no timeout of our own. A transaction's start is still bounded by Prisma's
 *   maxWait (2 s), which fails with P2028 "Unable to start a transaction", and withRetry retries it.
 */
export const PRISMA_POOL = { max: 5, idleTimeoutMillis: 60_000 } as const;

/** A pool failure by its kind (class and code): a pg message can name the host. */
export function poolErrorKind(error: Error): string {
  const code = (error as { code?: unknown }).code;
  return [error.constructor?.name ?? error.name, typeof code === 'string' ? code : null].filter(Boolean).join(' ');
}

/**
 * An idle pooled connection that died (no caller saw it: the pool drops it and opens a new one when asked) is a warning;
 * a connection lost inside a transaction is an error (the transaction's caller also gets one).
 */
export function reportPoolError(where: 'idle' | 'transaction', error: Error): void {
  captureError(new Error(`[prisma] ${where} connection failed: ${poolErrorKind(error)}`), 'prisma-pool', undefined, where === 'idle' ? 'warning' : 'error');
}

/** A client on its own pool. Nothing connects until the first query. */
export function createPrismaClient(connectionString: string | undefined, log: Prisma.LogLevel[]): PrismaClient {
  const adapter = new PrismaPg(
    { connectionString, ...PRISMA_POOL },
    { onPoolError: error => reportPoolError('idle', error), onConnectionError: error => reportPoolError('transaction', error) },
  );
  return new PrismaClient({ adapter, log });
}
