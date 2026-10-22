/**
 * Credentials out of Sentry. Telegram initData (the X-Telegram-Init-Data header, or a body
 * field) and the WhatsApp famcal_session cookie both stay valid for 24h, and the SDK copies
 * every request header, the cookies, the URL with its query and the body into server
 * events. Root spans carry each header as an `http.request.header.<name>` attribute, and
 * the SDK's name filter misses x-telegram-init-data. In the browser, request.url and the
 * navigation breadcrumbs carry the launch fragment (#tgWebAppData=<initData>).
 *
 * Shared secrets too: the cron Authorization header, Telegram's webhook secret header, the
 * secret / sig / hub.verify_token query values, and the bot token a Telegram Bot API URL
 * carries in its path (/bot<id>:<token>/), also in server breadcrumbs and span descriptions.
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
  message?: string;
  data?: Dict;
}

interface ScrubbableEvent {
  request?: ScrubbableRequest;
  contexts?: Record<string, Dict | undefined>;
  spans?: { description?: string; data?: Dict }[];
  breadcrumbs?: ScrubbableBreadcrumb[];
}

const SCRUBBED = '[scrubbed]';
const INIT_DATA_PARAM = /initData=[^&#]*/gi;
const INIT_DATA_JSON = /"initData"\s*:\s*"[^"]*"?/g;
/** Query names whose value is a secret: the cron secret, image-link signatures, Meta's verify token. */
const SECRET_PARAM_NAMES = ['secret', 'sig', 'hub.verify_token'];
const SECRET_PARAM = /(^|[?&])(secret|sig|hub\.verify_token)=[^&#]*/gi;
/** A Telegram Bot API path, /bot<id>:<token> ('%3A' when the colon is encoded). */
const BOT_TOKEN_PATH = /\/bot\d+(?::|%3A)[A-Za-z0-9_-]+/gi;
/** Request headers that carry a credential, lower-cased. */
const SECRET_HEADERS = new Set(['x-telegram-init-data', 'cookie', 'authorization', 'x-telegram-bot-api-secret-token']);
/** The same headers as span attribute names: http.request.header.<name>, '-' as '_'. */
const SECRET_HEADER_ATTRIBUTE = /^http\.request\.header\.(x_telegram_init_data|cookie|authorization|x_telegram_bot_api_secret_token)(\..*)?$/;

/** initData, the secret query values and a bot token scrubbed from a URL, a path or a description. */
function scrubSecrets(text: string): string {
  return text
    .replace(INIT_DATA_PARAM, `initData=${SCRUBBED}`)
    .replace(SECRET_PARAM, `$1$2=${SCRUBBED}`)
    .replace(BOT_TOKEN_PATH, `/bot${SCRUBBED}`);
}

/** A URL or path with initData, the secret query values and a bot token scrubbed, and no #fragment. */
export function scrubUrl(url: string): string {
  const hash = url.indexOf('#');
  return scrubSecrets(hash === -1 ? url : url.slice(0, hash));
}

const isSecretParam = (name: unknown) =>
  name === 'initData' || (typeof name === 'string' && SECRET_PARAM_NAMES.includes(name.toLowerCase()));

function scrubQuery(query: unknown): unknown {
  if (typeof query === 'string') return scrubSecrets(query);
  if (Array.isArray(query)) {
    return query.map((pair) => (Array.isArray(pair) && isSecretParam(pair[0]) ? [pair[0], SCRUBBED] : pair));
  }
  if (query && typeof query === 'object') {
    const secretKeys = Object.keys(query).filter(isSecretParam);
    if (secretKeys.length === 0) return query;
    const scrubbed: Dict = { ...(query as Dict) };
    for (const key of secretKeys) scrubbed[key] = SCRUBBED;
    return scrubbed;
  }
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

/** Drops the credential header attributes; scrubs initData, secret query values and a bot token from any string. */
function scrubSpanData(data: Dict | undefined) {
  if (!data) return;
  for (const key of Object.keys(data)) {
    if (SECRET_HEADER_ATTRIBUTE.test(key.toLowerCase().replace(/-/g, '_'))) {
      delete data[key];
    } else if (typeof data[key] === 'string') {
      data[key] = scrubSecrets(data[key] as string);
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

/** Server and edge `beforeSendTransaction`: the span header attributes and descriptions, and the request. */
export function scrubServerTransaction<E extends ScrubbableEvent>(event: E): E {
  scrubServerEvent(event);
  scrubSpanData(event.contexts?.trace?.data as Dict | undefined);
  for (const span of event.spans ?? []) {
    scrubSpanData(span.data);
    if (typeof span.description === 'string') span.description = scrubSecrets(span.description);
  }
  return event;
}

/**
 * Server `beforeBreadcrumb`: outgoing http and fetch breadcrumbs carry the full URL, and a
 * Telegram Bot API call has the bot token in its path. Scrubs the message and every string
 * in the data.
 */
export function scrubServerBreadcrumb<B extends ScrubbableBreadcrumb>(breadcrumb: B): B {
  if (typeof breadcrumb.message === 'string') breadcrumb.message = scrubSecrets(breadcrumb.message);
  const data = breadcrumb.data;
  if (data) {
    for (const key of Object.keys(data)) {
      if (typeof data[key] === 'string') data[key] = scrubSecrets(data[key] as string);
    }
  }
  return breadcrumb;
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
