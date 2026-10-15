import { INIT_DATA_HEADER } from './read-init-data';

/**
 * The Telegram initData an API request carries: the X-Telegram-Init-Data header, else a
 * non-empty string `initData` in the parsed JSON body. Never the query string: initData
 * stays valid for 24h (INIT_DATA_MAX_AGE_SEC) and URLs end up in access logs and Sentry.
 * Pass the parsed body when the route reads one (a body can be read only once).
 */
export function requestInitData(request: Request, body?: unknown): string | undefined {
  const fromHeader = request.headers.get(INIT_DATA_HEADER);
  if (fromHeader) return fromHeader;
  const fromBody = body && typeof body === 'object' ? (body as { initData?: unknown }).initData : undefined;
  return typeof fromBody === 'string' && fromBody !== '' ? fromBody : undefined;
}
