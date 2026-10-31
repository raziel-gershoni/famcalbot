import * as Sentry from '@sentry/nextjs';
import { scrubServerBreadcrumb, scrubServerEvent, scrubServerTransaction } from './src/lib/sentry-scrub';

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  // Only enable in production
  enabled: process.env.NODE_ENV === 'production',

  // Error reports only (src/lib/sentry-errors-only.ts; the Privacy Policy says error reports): no tracesSampleRate or
  // tracesSampler, no session aggregate of the requests (the Http integration is the SDK's own, as @sentry/nextjs sets
  // it up, with sessions off), no count-only client reports
  integrations: [Sentry.httpIntegration({ disableIncomingRequestSpans: true, trackIncomingRequestsAsSessions: false })],
  sendClientReports: false,

  // Set environment
  environment: process.env.NODE_ENV || 'development',

  // No Telegram initData or WhatsApp session cookie in events (both are 24h credentials),
  // and no shared secret or bot token
  beforeSend: (event) => scrubServerEvent(event),
  // A transaction is scrubbed too, should tracing ever be turned back on
  beforeSendTransaction: (event) => scrubServerTransaction(event),
  // Outgoing request breadcrumbs: a Telegram Bot API URL carries the bot token in its path
  beforeBreadcrumb: (breadcrumb) => scrubServerBreadcrumb(breadcrumb),
});
