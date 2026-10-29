import type { ReactNode } from 'react';
import '../globals.css';

/**
 * The root layout of the three Google connect pages: /refresh-token, /oauth-callback and /oauth-complete
 * (plan W4-3). The route group changes no URL: the proxy still skips the three paths (proxy.ts) and robots.ts
 * still keeps them out of search.
 *
 * It loads the app's global CSS, whose tokens (--bg-white, --text-primary, --brand-primary-dark) are the kit's
 * colours outside Telegram, which is where two of these pages always run. The document itself (<html lang dir>,
 * the provider, the Telegram SDK on /refresh-token only) is ConnectShell's, which each page renders: the
 * language is the page's to know (the user's, the browser's or ?locale), and a layout sees no search params.
 */
export default function ConnectLayout({ children }: { children: ReactNode }) {
  return children;
}
