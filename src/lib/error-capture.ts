/**
 * Centralized Error Capture
 * Logs to console and captures to Sentry with context
 */

import * as Sentry from '@sentry/nextjs';

type SeverityLevel = 'fatal' | 'error' | 'warning' | 'info';

interface ErrorContext {
  user_id?: number | string;
  command?: string;
  api_route?: string;
  service?: string;
  [key: string]: unknown;
}

/**
 * Capture an error to console and Sentry
 */
export function captureError(
  error: unknown,
  context: string,
  extra?: ErrorContext,
  severity: SeverityLevel = 'error'
): void {
  // Always log to console for local dev. Respect severity for the console sink
  // so warning/info-level captures don't surface as red errors in log
  // aggregators (e.g. Railway tags everything on stderr as 'error').
  const consoleFn =
    severity === 'warning' ? console.warn : severity === 'info' ? console.info : console.error;
  consoleFn(`[${context}]`, error);

  // Capture to Sentry with context
  Sentry.withScope(scope => {
    scope.setTag('context', context);
    scope.setLevel(severity);

    // Set common tags from extra
    if (extra?.user_id) scope.setTag('user_id', String(extra.user_id));
    if (extra?.command) scope.setTag('command', extra.command);
    if (extra?.api_route) scope.setTag('api_route', extra.api_route);
    if (extra?.service) scope.setTag('service', extra.service);

    // Set all extra data
    if (extra) scope.setExtras(extra);

    Sentry.captureException(error);
  });
}

/**
 * Capture a warning message to console and Sentry
 */
export function captureWarning(
  message: string,
  context: string,
  extra?: ErrorContext
): void {
  console.warn(`[${context}]`, message);

  Sentry.withScope(scope => {
    scope.setTag('context', context);
    scope.setLevel('warning');

    if (extra?.user_id) scope.setTag('user_id', String(extra.user_id));
    if (extra) scope.setExtras(extra);

    Sentry.captureMessage(message);
  });
}

/**
 * Capture an info message (for tracking non-error events)
 */
export function captureInfo(
  message: string,
  context: string,
  extra?: ErrorContext
): void {
  console.info(`[${context}]`, message);

  Sentry.withScope(scope => {
    scope.setTag('context', context);
    scope.setLevel('info');

    if (extra) scope.setExtras(extra);

    Sentry.captureMessage(message);
  });
}
