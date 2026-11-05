import type { MetadataRoute } from 'next';
import { APP_TOKENS } from '@/components/app-ui/tokens';

// FamCal as a web app a person can add to the Home Screen or install (web push spec 2026-11-05 §3.3): on an iPhone or iPad
// notifications work only for an app added there, and Android and desktop browsers install it from the same file.
//
// - Served at /manifest.webmanifest, which the proxy skips (a path with a dot), so no locale is added. Next links it from
//   every page's head, the public site's too (a file convention of the app folder).
// - start_url is /dashboard: the proxy picks the person's language, and the dashboard page then adds ?user_id= for a signed-in
//   session (a visitor with none gets the sign-in).
// - The colours are the app's own tokens (components/app-ui/tokens.ts), the light ones: a manifest holds one. The (app)
//   layout's viewport gives the dark one to a device in dark mode.
// - The icons are public/icon.png made smaller once (macOS sips, see the plan's Task 4), and committed: a maskable one with
//   the artwork inside the safe zone, so a round or rounded crop cuts none of it. app/apple-icon.png is the Home Screen icon.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'FamCal',
    short_name: 'FamCal',
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    background_color: APP_TOKENS.light.bg,
    theme_color: APP_TOKENS.light.bg,
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
