import type { ReactNode } from 'react';
import Script from 'next/script';

/**
 * /refresh-token sits outside app/[locale], so this is its own root layout. It loads the
 * Telegram SDK before hydration, as the [locale] layout does. The dashboard reaches this
 * page with a full page load (a different root layout) and no #tgWebAppData hash; the
 * SDK restores initData from its sessionStorage copy. On a direct launch it stores the
 * hash's initData for the select-calendars page this one moves on to.
 */
export default function RefreshTokenLayout({ children }: { children: ReactNode }) {
  return (
    <html>
      <head>
        <Script src="https://telegram.org/js/telegram-web-app.js" strategy="beforeInteractive" />
      </head>
      <body>{children}</body>
    </html>
  );
}
