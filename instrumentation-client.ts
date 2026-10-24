// The browser's Sentry init. Next 16 builds on Turbopack, which loads this file (and ignores
// the old sentry.client.config.ts). The DSN is the NEXT_PUBLIC_SENTRY_DSN env var, inlined at build.
import * as Sentry from '@sentry/nextjs';
import { scrubBreadcrumb, scrubBrowserEvent } from './src/lib/sentry-scrub';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Only enable in production
  enabled: process.env.NODE_ENV === 'production',

  // Performance monitoring
  tracesSampleRate: 0.01, // 1% of transactions

  // Session replay for debugging user issues
  replaysSessionSampleRate: 0.01,
  replaysOnErrorSampleRate: 1.0,

  // Filter out noisy errors
  ignoreErrors: [
    'ResizeObserver loop limit exceeded',
    'Non-Error promise rejection captured',
  ],

  // No launch fragment (#tgWebAppData=<initData>) in URLs
  beforeSend: (event) => scrubBrowserEvent(event),
  beforeSendTransaction: (event) => scrubBrowserEvent(event),
  beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
});

// Sentry's hook for client-side navigations in the App Router (Sentry's Next.js manual setup).
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
