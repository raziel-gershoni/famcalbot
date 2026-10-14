/**
 * The Mini App's signed initData, read in the browser (PageGate, /refresh-token). No
 * imports, so client components can use it. In order:
 *
 * 1. the Telegram SDK (window.Telegram.WebApp.initData), once telegram-web-app.js has run;
 * 2. the launch URL's hash (#tgWebAppData=...), where Telegram puts it on a direct launch;
 * 3. the SDK's own copy in sessionStorage ('__telegram__initParams'), which it writes on
 *    every page it runs on. A full page load inside the webview has no hash: the
 *    dashboard's push to /refresh-token (a different root layout), or /refresh-token's
 *    move on to select-calendars. This copy still has the launch initData.
 *
 * '' outside Telegram, where the WhatsApp session cookie is the credential.
 */
export function readInitData(): string {
  if (typeof window === 'undefined') return '';
  const fromSdk = window.Telegram?.WebApp?.initData;
  if (fromSdk) return fromSdk;
  try {
    const fromHash = new URLSearchParams(window.location.hash.slice(1)).get('tgWebAppData');
    if (fromHash) return fromHash;
  } catch {
    // No usable hash; try the SDK's copy
  }
  try {
    const stored: unknown = JSON.parse(window.sessionStorage.getItem('__telegram__initParams') ?? 'null');
    const fromStorage = (stored as { tgWebAppData?: unknown } | null)?.tgWebAppData;
    if (typeof fromStorage === 'string') return fromStorage;
  } catch {
    // sessionStorage blocked or not JSON
  }
  return '';
}
