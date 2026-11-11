// Kept apart from prisma.ts so a smoke can load the real retry without a PrismaClient.
import { Prisma } from '@prisma/client';

/** Node's codes for a connect that failed on every address of a host (an AggregateError; Prisma 7 may also wrap it as a known error whose code is this Node code). */
const CONNECT_FAILED = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH']);

/**
 * True only when nothing ran: the database could not be reached (P1001 from a model query or a transaction's start; a
 * raw query reports the same as P2010 with the adapter's DatabaseNotReachable; a host whose every address refused gives
 * Node's AggregateError, which Prisma may wrap as a known error carrying Node's code), or a transaction could not start
 * in time (P2028 "Unable to start a transaction"). Not a query or validation error, a refused password (P1000), a lost connection (the statement may have run), or another P2028
 * such as "Transaction already closed". With Prisma 7's adapter nothing connects at startup, so an unreachable database
 * never surfaces as PrismaClientInitializationError.
 */
function nothingRan(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const kind = (error.meta as { driverAdapterError?: { cause?: { kind?: unknown } } } | undefined)?.driverAdapterError?.cause?.kind;
    return error.code === 'P1001'
      || CONNECT_FAILED.has(error.code)
      || (error.code === 'P2010' && kind === 'DatabaseNotReachable')
      || (error.code === 'P2028' && error.message.includes('Unable to start a transaction'));
  }
  return error instanceof AggregateError && CONNECT_FAILED.has(String((error as { code?: unknown }).code));
}

/** Retry wrapper for DB operations that may fail while Neon wakes up (see nothingRan). */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 2,
  delayMs = 2000,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!nothingRan(error) || attempt === maxRetries) throw error;
      console.warn(`[DB] Connection or transaction start failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delayMs}ms...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error('Unreachable');
}
