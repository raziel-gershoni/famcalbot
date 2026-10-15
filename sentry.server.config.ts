import * as Sentry from '@sentry/nextjs';
import { scrubServerEvent, scrubServerTransaction } from './src/lib/sentry-scrub';

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  // Only enable in production
  enabled: process.env.NODE_ENV === 'production',

  // Performance monitoring
  tracesSampleRate: 0.01, // 1% of transactions

  // Set environment
  environment: process.env.NODE_ENV || 'development',

  // No Telegram initData or WhatsApp session cookie in events (both are 24h credentials)
  beforeSend: (event) => scrubServerEvent(event),
  beforeSendTransaction: (event) => scrubServerTransaction(event),
});
