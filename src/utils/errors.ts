/**
 * Custom error classes for better error handling
 */

export class TokenExpiredError extends Error {
  constructor(public userId: number, message = 'Google Calendar token has expired') {
    super(message);
    this.name = 'TokenExpiredError';
  }
}

export class DatabaseConnectionError extends Error {
  constructor(message = 'Failed to connect to database', public originalError?: Error) {
    super(message);
    this.name = 'DatabaseConnectionError';
  }
}

export class InsufficientScopesError extends Error {
  constructor(public userId: number, message = 'Google Calendar token has insufficient scopes') {
    super(message);
    this.name = 'InsufficientScopesError';
  }
}

/**
 * Check if error is specifically an insufficient scopes error
 * This happens when user deselected permissions on Google consent screen
 */
export function isInsufficientScopesError(error: unknown): boolean {
  if (!error) return false;

  const err = error as { message?: string; code?: number };
  const message = err.message?.toLowerCase() || '';
  const code = err.code;

  // Google API returns 403 with specific scope-related messages
  return (
    code === 403 &&
    (message.includes('insufficient') ||
     message.includes('scope') ||
     message.includes('insufficientpermissions'))
  );
}

export function isTokenError(error: unknown): boolean {
  if (!error) return false;

  const err = error as { message?: string; code?: number };
  const message = err.message?.toLowerCase() || '';
  const code = err.code;

  // Don't treat scope errors as token errors - they need different handling
  if (isInsufficientScopesError(error)) {
    return false;
  }

  return (
    code === 401 ||
    code === 403 ||
    message.includes('invalid_grant') ||
    message.includes('invalid credentials') ||
    message.includes('token') ||
    message.includes('unauthorized')
  );
}
