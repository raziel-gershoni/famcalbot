// Kept apart from prisma.ts so a smoke can load the real retry without a PrismaClient.
import { Prisma } from '@prisma/client';

/**
 * Node's codes for a connect that failed on every address of a host. Node reports it as an AggregateError, and Prisma
 * always wraps that as a PrismaClientKnownRequestError whose code is the Node code.
 */
const CONNECT_FAILED = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH']);

/**
 * The same codes once Prisma has wrapped them. Only these two are retried, because only these two can come from a
 * connect alone: a refused connection happens only at connect time, and an ETIMEDOUT that carries a syscall maps to
 * P1008 (never to this code), so a wrapped ETIMEDOUT comes only from a connect's AggregateError. EHOSTUNREACH and
 * ENETUNREACH can also be a socket error that cuts a statement already sent (the COMMIT of a transaction included),
 * which adapter-pg rethrows raw and Prisma then wraps with that code too: retrying it would run a write twice.
 */
const WRAPPED_CONNECT_FAILED = new Set(['ECONNREFUSED', 'ETIMEDOUT']);

/**
 * True only when nothing ran: the database could not be reached (P1001 from a model query or a transaction's start; a
 * raw query reports the same as P2010 with the adapter's DatabaseNotReachable; a host whose every address refused gives
 * Node's AggregateError, which Prisma wraps as a known error carrying Node's ECONNREFUSED or ETIMEDOUT), or a
 * transaction could not start in time (P2028 "Unable to start a transaction"). A bare AggregateError (not wrapped)
 * can only be a connect, so all four Node codes count for it. Not a query or validation error, a refused password
 * (P1000), a lost connection (the statement may have run), a wrapped EHOSTUNREACH or ENETUNREACH (see
 * WRAPPED_CONNECT_FAILED), or another P2028 such as "Transaction already closed". With Prisma 7's adapter nothing
 * connects at startup, so an unreachable database never surfaces as PrismaClientInitializationError.
 */
function nothingRan(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const kind = (error.meta as { driverAdapterError?: { cause?: { kind?: unknown } } } | undefined)?.driverAdapterError?.cause?.kind;
    return error.code === 'P1001'
      || WRAPPED_CONNECT_FAILED.has(error.code)
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
