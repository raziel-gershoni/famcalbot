/**
 * Credentials out of Sentry. Telegram initData (the X-Telegram-Init-Data header, or a body
 * field, 24h) and the __Host-famcal_session cookie (up to 30 days) stay valid, and the SDK copies
 * every request header, the cookies, the URL with its query and the body into server
 * events. Root spans carry each header as an `http.request.header.<name>` attribute, and
 * the SDK's name filter misses x-telegram-init-data. In the browser, request.url and the
 * navigation breadcrumbs carry the launch fragment (#tgWebAppData=<initData>).
 *
 * Shared secrets too: the cron Authorization header, Telegram's webhook secret header, the
 * secret / sig / hub.verify_token query values, and the bot token a Telegram Bot API URL
 * carries in its path (/bot<id>:<token>/), also in server breadcrumbs, span descriptions and the
 * transaction name.
 *
 * And sign-in's one-time values and the email address (web sign-in spec §8): code, state,
 * token, id_token and email leave URLs, queries and JSON or form bodies. That also covers the
 * Google Calendar connect's code and state, its Finish here id (token) and the WhatsApp magic
 * link's token. A body's name goes too (Create account sends the name typed on /signup, web
 * sign-up spec §8): no Sentry field holds a person's name. A partner invite's token leaves them
 * too (web sign-up spec §3.7): the `invite` name, and the invite page's own path,
 * /invite/<64 hex>, wherever a URL or a name holds it.
 *
 * Browser notifications (spec 2026-11-05-web-push §3.4): a device's endpoint is a credential (its path is the push
 * service's token for that browser), and its keys too. The endpoint, keys, p256dh and auth names leave bodies, and the
 * push services' URL paths (FCM's, Apple's, Mozilla's, WNS's) leave every URL, breadcrumb, name and description
 * (web-push/config.ts PUSH_SERVICE_HOSTS are the hosts a device may use; smoke-sentry-scrub #15 holds the two together).
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
  /** A transaction event's name: a root span for an outgoing call is named by its URL */
  transaction?: string;
  contexts?: Record<string, Dict | undefined>;
  spans?: { description?: string; data?: Dict }[];
  breadcrumbs?: ScrubbableBreadcrumb[];
}

const SCRUBBED = '[scrubbed]';
const INIT_DATA_PARAM = /initData=[^&#]*/gi;
/**
 * Query names whose value is a secret: the cron secret, image-link signatures, Meta's verify token, an OAuth code and
 * state, a one-time link's token, an id_token, an email address, and a partner invite's token.
 */
const SECRET_PARAM_NAMES = ['secret', 'sig', 'hub.verify_token', 'code', 'state', 'token', 'id_token', 'email', 'invite'];
const SECRET_PARAM = /(^|[?&])(secret|sig|hub\.verify_token|code|state|token|id_token|email|invite)=[^&#]*/gi;
/**
 * Body fields dropped from a request body, any case: initData, sign-in's code, state, token, id_token, email and invite,
 * a name, and a browser's push subscription (endpoint, keys, p256dh, auth).
 */
const SECRET_BODY_FIELDS = new Set(['initdata', 'code', 'state', 'token', 'id_token', 'email', 'name', 'invite', 'endpoint', 'keys', 'p256dh', 'auth']);
/** The same fields as JSON members (a string, or a bare number or word), for JSON the SDK cut off at its size limit. */
const SECRET_JSON_MEMBER = /"(initData|code|state|token|id_token|email|name|invite|endpoint|keys|p256dh|auth)"\s*:\s*(?:"(?:[^"\\]|\\.)*"?|[^,}\]\s]*)/gi;
/** And as fields of a form body. */
const SECRET_FORM_FIELD = /(^|&)(initData|code|state|token|id_token|email|name|invite|endpoint|keys|p256dh|auth)=[^&]*/gi;
/** A Telegram Bot API path, /bot<id>:<token> ('%3A' when the colon is encoded). */
const BOT_TOKEN_PATH = /\/bot\d+(?::|%3A)[A-Za-z0-9_-]+/gi;
/**
 * Connect Telegram's one-time token, w_<22 base64url characters> (src/services/telegram-connect.ts): in the /start text
 * of the Telegram webhook's body, and in any breadcrumb or URL that quotes it.
 */
const CONNECT_TOKEN = /\bw_[A-Za-z0-9_-]{22}(?![A-Za-z0-9_-])/g;
/**
 * The Google connect's pending id, gc_<32 base64url characters> (src/services/google-connect.ts): it rides in the same
 * /start text, and in a WhatsApp message, so it is scrubbed the same way.
 */
const GOOGLE_CONNECT_ID = /\bgc_[A-Za-z0-9_-]{32}(?![A-Za-z0-9_-])/g;
/** Both ids out of a string. gc_ first: a w_ pattern could match inside a gc_ id that holds "-w_" and leave the rest. */
function scrubConnectIds(text: string): string {
  return text.replace(GOOGLE_CONNECT_ID, `gc_${SCRUBBED}`).replace(CONNECT_TOKEN, `w_${SCRUBBED}`);
}
/** The partner invite page's path, /invite/<the token's 64 hex characters> (src/lib/invite-token.ts), in a URL or a name. */
const INVITE_PATH = /\/invite\/[0-9a-f]{64}(?![0-9a-f])/gi;
/**
 * A push service's URL path, the token of one browser's subscription: FCM (fcm.googleapis.com/fcm/send/<token>), Apple
 * (*.push.apple.com/<token>), Mozilla (*.push.services.mozilla.com/wpush/v2/<token>) and WNS (*.notify.windows.com/w/,
 * its token in the query, which SECRET_PARAM scrubs). The host stays, for debugging. A path already scrubbed is left as
 * it is, so a second scrub changes nothing.
 */
const PUSH_SERVICE_PATH = /(https?:\/\/(?:[a-z0-9-]+\.)*(?:fcm\.googleapis\.com|push\.apple\.com|push\.services\.mozilla\.com|notify\.windows\.com)(?::\d+)?)\/(?!\[scrubbed\])[^\s?#"']+/gi;
/** Request headers that carry a credential, lower-cased. */
const SECRET_HEADERS = new Set(['x-telegram-init-data', 'cookie', 'authorization', 'x-telegram-bot-api-secret-token']);
/** The same headers as span attribute names: http.request.header.<name>, '-' as '_'. */
const SECRET_HEADER_ATTRIBUTE = /^http\.request\.header\.(x_telegram_init_data|cookie|authorization|x_telegram_bot_api_secret_token)(\..*)?$/;

/** initData, the secret query values, a bot token and a push service's path scrubbed from a URL, a path or a description. */
function scrubSecrets(text: string): string {
  return text
    .replace(INIT_DATA_PARAM, `initData=${SCRUBBED}`)
    .replace(SECRET_PARAM, `$1$2=${SCRUBBED}`)
    .replace(BOT_TOKEN_PATH, `/bot${SCRUBBED}`)
    .replace(GOOGLE_CONNECT_ID, `gc_${SCRUBBED}`)
    .replace(CONNECT_TOKEN, `w_${SCRUBBED}`)
    .replace(INVITE_PATH, `/invite/${SCRUBBED}`)
    .replace(PUSH_SERVICE_PATH, `$1/${SCRUBBED}`);
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

const isSecretField = (name: string) => SECRET_BODY_FIELDS.has(name.toLowerCase());
const hasSecretField = (body: object) => Object.keys(body).some(isSecretField);

function withoutSecretFields(body: Dict): Dict {
  return Object.fromEntries(Object.entries(body).filter(([name]) => !isSecretField(name)));
}

function scrubBody(data: unknown): unknown {
  if (typeof data === 'string') {
    try {
      const parsed: unknown = JSON.parse(data);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (!hasSecretField(parsed)) return data;
        return JSON.stringify(withoutSecretFields(parsed as Dict));
      }
    } catch {
      // A form body, or JSON the SDK cut off at its size limit
    }
    return data
      .replace(SECRET_JSON_MEMBER, `"$1":"${SCRUBBED}"`)
      .replace(SECRET_FORM_FIELD, `$1$2=${SCRUBBED}`)
      .replace(INIT_DATA_PARAM, `initData=${SCRUBBED}`);
  }
  if (data && typeof data === 'object' && !Array.isArray(data) && hasSecretField(data)) {
    return withoutSecretFields(data as Dict);
  }
  return data;
}

/**
 * A Telegram Guest Mode update (`guest_message`) carries a message from another chat, often written by someone who never
 * used FamCal (the one the person replied to when they mentioned the bot), so the whole message leaves the body and only
 * the update's id stays. A body that is a string is matched as text, so JSON the SDK cut off is caught too.
 */
const GUEST_MESSAGE_MEMBER = /"guest_message"\s*:/;
function scrubGuestBody(data: unknown): unknown {
  if (typeof data === 'string') {
    if (!GUEST_MESSAGE_MEMBER.test(data)) return data;
    const id = data.match(/"update_id"\s*:\s*(\d+)/)?.[1];
    return JSON.stringify(id ? { update_id: Number(id), guest_message: SCRUBBED } : { guest_message: SCRUBBED });
  }
  if (data && typeof data === 'object' && !Array.isArray(data) && 'guest_message' in data) {
    const updateId = (data as Dict).update_id;
    return updateId === undefined ? { guest_message: SCRUBBED } : { update_id: updateId, guest_message: SCRUBBED };
  }
  return data;
}

/**
 * Connect Telegram's token and the Google connect's pending id out of a request body of any shape: the Telegram
 * webhook's update carries them deep inside (message.text), where the field rules above don't look. A body that can't
 * be written out as JSON is left as it is.
 */
function scrubConnectBody(data: unknown): unknown {
  if (typeof data === 'string') return scrubConnectIds(data);
  if (!data || typeof data !== 'object') return data;
  try {
    const text = JSON.stringify(data);
    const scrubbed = scrubConnectIds(text);
    return scrubbed === text ? data : JSON.parse(scrubbed);
  } catch {
    console.warn('[sentry-scrub] a request body could not be read for a Connect Telegram token');
    return data;
  }
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

/** Server and edge `beforeSend`: no initData, session cookie or sign-in secret in the event's request. */
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
    if (request.data !== undefined) request.data = scrubConnectBody(scrubBody(scrubGuestBody(request.data)));
  }
  // onRequestError records the request path, query included
  const nextjs = event.contexts?.nextjs;
  if (nextjs && typeof nextjs.request_path === 'string') nextjs.request_path = scrubUrl(nextjs.request_path);
  return event;
}

/** Server and edge `beforeSendTransaction`: the span header attributes and descriptions, the transaction name, and the request. */
export function scrubServerTransaction<E extends ScrubbableEvent>(event: E): E {
  scrubServerEvent(event);
  scrubSpanData(event.contexts?.trace?.data as Dict | undefined);
  // A root span for an outgoing call is named by its URL, and that name becomes the transaction's
  if (typeof event.transaction === 'string') event.transaction = scrubSecrets(event.transaction);
  const trace = event.contexts?.trace;
  if (trace && typeof trace.description === 'string') trace.description = scrubSecrets(trace.description);
  for (const span of event.spans ?? []) {
    scrubSpanData(span.data);
    if (typeof span.description === 'string') span.description = scrubSecrets(span.description);
  }
  return event;
}

/** Outgoing requests whose query names the person's place: MET's forecast (lat, lon) and Nominatim (q). */
const PLACE_QUERY_HOSTS = new Set(['api.met.no', 'nominatim.openstreetmap.org']);

/** The host of a breadcrumb's url, or '' when it is not a URL. */
function breadcrumbHost(url: unknown): string {
  if (typeof url !== 'string') return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * Server `beforeBreadcrumb`: outgoing http and fetch breadcrumbs carry the full URL, and a
 * Telegram Bot API call has the bot token in its path. Scrubs the message and every string
 * in the data. A request to a place lookup or the forecast loses its query (`http.query`, and
 * any query left on the url): it holds the person's place, by name or by coordinates.
 */
export function scrubServerBreadcrumb<B extends ScrubbableBreadcrumb>(breadcrumb: B): B {
  if (typeof breadcrumb.message === 'string') breadcrumb.message = scrubSecrets(breadcrumb.message);
  const data = breadcrumb.data;
  if (data) {
    for (const key of Object.keys(data)) {
      if (typeof data[key] === 'string') data[key] = scrubSecrets(data[key] as string);
    }
    if (PLACE_QUERY_HOSTS.has(breadcrumbHost(data.url))) {
      delete data['http.query'];
      data.url = (data.url as string).split(/[?#]/)[0];
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
