/**
 * Prisma Client Singleton
 * Prevents connection pool exhaustion in serverless environments
 */

import { PrismaClient } from '@prisma/client';
import * as Sentry from '@sentry/nextjs';

declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

export const prisma =
  global.prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  global.prisma = prisma;
}

/**
 * Graceful disconnect (call this at the end of serverless functions)
 */
export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}

/**
 * Connect with retry logic
 */
export async function connectPrisma(retries = 3): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await prisma.$connect();
      return;
    } catch (error) {
      console.error(`Failed to connect to database (attempt ${i + 1}/${retries}):`, error);
      if (i === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1))); // Exponential backoff
    }
  }
}

/**
 * Check if an error is a database connection error
 * These are transient errors that can be retried (e.g., Neon cold start)
 */
function isConnectionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const err = error as { name?: string; code?: string; message?: string };

  // Prisma connection errors
  if (err.name === 'PrismaClientInitializationError') return true;
  if (err.name === 'PrismaClientKnownRequestError') {
    // P1001: Can't reach database, P1002: Timeout, P2024: Connection pool timeout
    if (['P1001', 'P1002', 'P2024'].includes(err.code || '')) return true;
  }

  // Check error message for connection-related issues
  const message = err.message?.toLowerCase() || '';
  if (message.includes("can't reach database server")) return true;
  if (message.includes('connection refused')) return true;
  if (message.includes('connection timed out')) return true;
  if (message.includes('econnrefused')) return true;
  if (message.includes('enotfound')) return true;

  return false;
}

/**
 * Wrap a database operation with retry logic for connection failures
 * Retries once after 1 second delay if a connection error occurs
 *
 * @param operation - Async function that performs the database operation
 * @param context - Optional context string for logging
 * @returns The result of the operation
 */
export async function withDbRetry<T>(
  operation: () => Promise<T>,
  context?: string
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isConnectionError(error)) {
      const ctx = context || 'unknown';
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Log to console
      console.warn(`[DB Retry] [${ctx}] Connection error, retrying in 1s...`, errorMsg);

      // Track in Sentry as warning (not error) to monitor cold start frequency
      Sentry.withScope(scope => {
        scope.setTag('db_retry', 'true');
        scope.setTag('db_context', ctx);
        scope.setLevel('warning');
        scope.setExtra('error_message', errorMsg);
        Sentry.captureMessage(`Database connection retry: ${ctx}`);
      });

      // Wait 1 second for Neon to wake up
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Retry once
      return await operation();
    }

    // Not a connection error, re-throw
    throw error;
  }
}
