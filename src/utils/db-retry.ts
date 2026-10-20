// Kept apart from prisma.ts so a smoke can load the real retry without a PrismaClient.
import { Prisma } from '@prisma/client';

/**
 * Retry wrapper for DB operations that may fail due to Neon cold starts.
 * Only retries on connection errors and on a transaction that could not start (P2028
 * "Unable to start a transaction": nothing ran, so a retry is safe), not on query or
 * validation errors, nor on other P2028s such as "Transaction already closed".
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 2,
  delayMs = 2000,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isConnectionError =
        error instanceof Prisma.PrismaClientInitializationError ||
        (error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === 'P1001' || (error.code === 'P2028' && error.message.includes('Unable to start a transaction'))));
      if (!isConnectionError || attempt === maxRetries) throw error;
      console.warn(`[DB] Connection or transaction start failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delayMs}ms...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error('Unreachable');
}
