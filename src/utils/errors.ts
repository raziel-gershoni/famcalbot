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

export function isTokenError(error: any): boolean {
  if (!error) return false;

  const message = error.message?.toLowerCase() || '';
  const code = error.code;

  return (
    code === 401 ||
    code === 403 ||
    message.includes('invalid_grant') ||
    message.includes('invalid credentials') ||
    message.includes('token') ||
    message.includes('unauthorized')
  );
}
