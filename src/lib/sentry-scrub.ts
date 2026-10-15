/**
 * Credentials out of Sentry. Telegram initData (the X-Telegram-Init-Data header, or a body
 * field) and the WhatsApp famcal_session cookie both stay valid for 24h, and the SDK copies
 * every request header, the cookies, the URL with its query and the body into server
 * events. Root spans carry each header as an `http.request.header.<name>` attribute, and
 * the SDK's name filter misses x-telegram-init-data. In the browser, request.url and the
 * navigation breadcrumbs carry the launch fragment (#tgWebAppData=<initData>).
 *
 * No imports: the server, edge and client Sentry configs all load this module. The types
 * are structural so Sentry's own event types fit them.
 */

type Dict = Record<string, unknown>;

interface ScrubbableRequest {
  url?: string;
  query_string?: unknown;
  data?: unknown;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
}

interface ScrubbableBreadcrumb {
  category?: string;
  data?: Dict;
}

interface ScrubbableEvent {
  request?: ScrubbableRequest;
  contexts?: Record<string, Dict | undefined>;
  spans?: { data?: Dict }[];
  breadcrumbs?: ScrubbableBreadcrumb[];
}

const SCRUBBED = '[scrubbed]';
const INIT_DATA_PARAM = /initData=[^&#]*/gi;
const INIT_DATA_JSON = /"initData"\s*:\s*"[^"]*"?/g;
/** Request headers that carry a credential, lower-cased. */
const SECRET_HEADERS = new Set(['x-telegram-init-data', 'cookie']);
/** The same headers as span attribute names: http.request.header.<name>, '-' as '_'. */
const SECRET_HEADER_ATTRIBUTE = /^http\.request\.header\.(x_telegram_init_data|cookie)(\..*)?$/;

/** A URL or path with initData scrubbed from its query and no #fragment. */
export function scrubUrl(url: string): string {
  const hash = url.indexOf('#');
  return (hash === -1 ? url : url.slice(0, hash)).replace(INIT_DATA_PARAM, `initData=${SCRUBBED}`);
}

function scrubQuery(query: unknown): unknown {
  if (typeof query === 'string') return query.replace(INIT_DATA_PARAM, `initData=${SCRUBBED}`);
  if (Array.isArray(query)) {
    return query.map((pair) => (Array.isArray(pair) && pair[0] === 'initData' ? [pair[0], SCRUBBED] : pair));
  }
  if (query && typeof query === 'object' && 'initData' in query) return { ...query, initData: SCRUBBED };
  return query;
}

function withoutInitData(body: Dict): Dict {
  const rest = { ...body };
  delete rest.initData;
  return rest;
}

function scrubBody(data: unknown): unknown {
  if (typeof data === 'string') {
    try {
      const parsed: unknown = JSON.parse(data);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (!('initData' in parsed)) return data;
        return JSON.stringify(withoutInitData(parsed as Dict));
      }
    } catch {
      // A form body, or JSON the SDK cut off at its size limit
    }
    return data.replace(INIT_DATA_JSON, `"initData":"${SCRUBBED}"`).replace(INIT_DATA_PARAM, `initData=${SCRUBBED}`);
  }
  if (data && typeof data === 'object' && !Array.isArray(data) && 'initData' in data) {
    return withoutInitData(data as Dict);
  }
  return data;
}

/** Drops the credential header attributes; scrubs initData from any URL-like string. */
function scrubSpanData(data: Dict | undefined) {
  if (!data) return;
  for (const key of Object.keys(data)) {
    if (SECRET_HEADER_ATTRIBUTE.test(key.toLowerCase().replace(/-/g, '_'))) {
      delete data[key];
    } else if (typeof data[key] === 'string') {
      data[key] = (data[key] as string).replace(INIT_DATA_PARAM, `initData=${SCRUBBED}`);
    }
  }
}

/** Server and edge `beforeSend`: no initData or session cookie in the event's request. */
export function scrubServerEvent<E extends ScrubbableEvent>(event: E): E {
  const request = event.request;
  if (request) {
    if (request.headers) {
      for (const name of Object.keys(request.headers)) {
        if (SECRET_HEADERS.has(name.toLowerCase())) delete request.headers[name];
      }
    }
    delete request.cookies;
    if (typeof request.url === 'string') request.url = scrubUrl(request.url);
    if (request.query_string !== undefined) request.query_string = scrubQuery(request.query_string);
    if (request.data !== undefined) request.data = scrubBody(request.data);
  }
  // onRequestError records the request path, query included
  const nextjs = event.contexts?.nextjs;
  if (nextjs && typeof nextjs.request_path === 'string') nextjs.request_path = scrubUrl(nextjs.request_path);
  return event;
}

/** Server and edge `beforeSendTransaction`: the span header attributes, and the request. */
export function scrubServerTransaction<E extends ScrubbableEvent>(event: E): E {
  scrubServerEvent(event);
  scrubSpanData(event.contexts?.trace?.data as Dict | undefined);
  for (const span of event.spans ?? []) scrubSpanData(span.data);
  return event;
}

/** Client `beforeBreadcrumb`: navigation, fetch and xhr URLs without their #fragment. */
export function scrubBreadcrumb<B extends ScrubbableBreadcrumb>(breadcrumb: B): B {
  const data = breadcrumb.data;
  if (!data) return breadcrumb;
  const keys = breadcrumb.category === 'navigation' ? ['from', 'to']
    : breadcrumb.category === 'fetch' || breadcrumb.category === 'xhr' ? ['url']
    : [];
  for (const key of keys) {
    if (typeof data[key] === 'string') data[key] = scrubUrl(data[key] as string);
  }
  return breadcrumb;
}

/** Client `beforeSend` and `beforeSendTransaction`: request.url and the breadcrumbs. */
export function scrubBrowserEvent<E extends ScrubbableEvent>(event: E): E {
  if (typeof event.request?.url === 'string') event.request.url = scrubUrl(event.request.url);
  event.breadcrumbs?.forEach(scrubBreadcrumb);
  return event;
}
