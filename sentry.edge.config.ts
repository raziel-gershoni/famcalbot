import * as Sentry from '@sentry/nextjs';
import { scrubServerEvent, scrubServerTransaction } from './src/lib/sentry-scrub';

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  // Only enable in production
  enabled: process.env.NODE_ENV === 'production',

  // Error reports only (src/lib/sentry-errors-only.ts; the Privacy Policy says error reports): no tracesSampleRate or
  // tracesSampler, no count-only client reports
  sendClientReports: false,

  // No Telegram initData or WhatsApp session cookie in events (both are 24h credentials)
  beforeSend: (event) => scrubServerEvent(event),
  // A transaction is scrubbed too, should tracing ever be turned back on
  beforeSendTransaction: (event) => scrubServerTransaction(event),
});
