/**
 * URL Configuration
 * Centralized URL helper to avoid hardcoded domain strings
 */

/**
 * Get the base URL for the application
 * Priority:
 * 1. NEXT_PUBLIC_APP_URL (explicit configuration)
 * 2. localhost for development
 */
export function getBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return process.env.NEXT_PUBLIC_APP_URL;
  }
  return 'http://localhost:3000';
}

/**
 * Build a full URL path
 * @param path - The path to append (with or without leading slash)
 * @returns Full URL with base
 */
export function buildUrl(path: string): string {
  const base = getBaseUrl();
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}
