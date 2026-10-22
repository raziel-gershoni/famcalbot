/**
 * Telegram webhook setup: the command run on deploy day, and after the bot token or the
 * webhook secret changes.
 *
 *   npm run setup-webhook set https://<host>/api/webhook
 *   npm run setup-webhook get
 *   npm run setup-webhook delete
 *
 * TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET come from the environment only (no
 * dotenv: the local .env holds DEV values). Both are required for every command, and a
 * missing one stops the script before any network call. getMe runs first and prints the
 * bot's @username, so a wrong token shows before anything changes. Nothing printed
 * contains the token or the secret.
 */

import https from 'https';

type Env = Record<string, string | undefined>;
type Log = (line: string) => void;
/** One Bot API call; resolves with `result`, rejects with Telegram's description. */
export type TelegramCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

export interface SetWebhookParams {
  url: string;
  secret_token: string;
}

/** Telegram's rule for secret_token. */
const SECRET_FORMAT = /^[A-Za-z0-9_-]{1,256}$/;
const WEBHOOK_URL_FORMAT = /^https:\/\/[^/]+\/api\/webhook$/;

/** The bot token and the webhook secret; throws naming each missing variable, never a value. */
export function readCredentials(env: Env): { token: string; secret: string } {
  const token = env.TELEGRAM_BOT_TOKEN;
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!token || !secret) {
    const missing = [token ? '' : 'TELEGRAM_BOT_TOKEN', secret ? '' : 'TELEGRAM_WEBHOOK_SECRET'].filter(Boolean);
    throw new Error(`${missing.join(' and ')} not set in the environment`);
  }
  return { token, secret };
}

/** setWebhook's parameters. Throws on a missing or malformed secret, or a URL other than https://<host>/api/webhook. */
export function buildSetWebhookParams(env: Env, url: string | undefined): SetWebhookParams {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) throw new Error('TELEGRAM_WEBHOOK_SECRET not set in the environment');
  if (!SECRET_FORMAT.test(secret)) {
    throw new Error('TELEGRAM_WEBHOOK_SECRET must be 1-256 characters of A-Z, a-z, 0-9, _ and -');
  }
  if (!url || !WEBHOOK_URL_FORMAT.test(url)) {
    throw new Error('The webhook URL must be https://<host>/api/webhook');
  }
  return { url, secret_token: secret };
}

/** Bot API calls over https. An error names the method and Telegram's description, never the URL. */
export function telegramCaller(token: string): TelegramCall {
  return (method, params) => new Promise((resolve, reject) => {
    const body = params ? JSON.stringify(params) : undefined;
    const req = https.request(`https://api.telegram.org/bot${token}/${method}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(text);
          if (json.ok) resolve(json.result);
          else reject(new Error(`${method}: ${json.description || `HTTP ${res.statusCode}`}`));
        } catch (err) {
          reject(new Error(`${method}: unreadable reply (HTTP ${res.statusCode}): ${err instanceof Error ? err.message : String(err)}`));
        }
      });
    });
    req.on('error', (err) => reject(new Error(`${method}: ${err.message}`)));
    if (body) req.write(body);
    req.end();
  });
}

interface WebhookInfo {
  url?: string;
  pending_update_count?: number;
  last_error_date?: number;
  last_error_message?: string;
}

/** The webhook's URL, pending update count and last error, in Israel time. */
async function printWebhookInfo(call: TelegramCall, log: Log) {
  const info = (await call('getWebhookInfo')) as WebhookInfo;
  log(`Webhook URL: ${info.url || '(none)'}`);
  log(`Pending updates: ${info.pending_update_count ?? 0}`);
  if (info.last_error_message) {
    const when = info.last_error_date
      ? ` (${new Date(info.last_error_date * 1000).toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem', dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' })})`
      : '';
    log(`Last error: ${info.last_error_message}${when}`);
  } else {
    log('Last error: none');
  }
}

const USAGE = [
  'Usage (TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET set in the environment):',
  '  npm run setup-webhook set https://<host>/api/webhook   - point the bot at this webhook, with the secret',
  '  npm run setup-webhook get                              - show the current webhook',
  '  npm run setup-webhook delete                           - remove the webhook (local polling only)',
];

/** Runs one command and returns the exit code. */
export async function run(
  args: string[],
  env: Env,
  makeCall: (token: string) => TelegramCall = telegramCaller,
  log: Log = console.log,
  logError: Log = console.error,
): Promise<number> {
  const [command, url] = args;
  if (command !== 'set' && command !== 'get' && command !== 'info' && command !== 'delete') {
    USAGE.forEach((line) => log(line));
    return command ? 1 : 0;
  }

  let credentials: { token: string; secret: string };
  let params: SetWebhookParams | null = null;
  try {
    credentials = readCredentials(env);
    if (command === 'set') params = buildSetWebhookParams(env, url);
  } catch (err) {
    logError(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const { token, secret } = credentials;
  const redact = (text: string) => text.split(token).join('[token]').split(secret).join('[secret]');

  const call = makeCall(token);
  try {
    const me = (await call('getMe')) as { username?: string };
    log(`Bot: @${me.username ?? '(no username)'}`);
    if (params) {
      await call('setWebhook', { ...params });
      log(`Webhook set to ${params.url}, with the secret token`);
      await printWebhookInfo(call, log);
    } else if (command === 'delete') {
      await call('deleteWebhook');
      log('Webhook deleted: production gets no updates until `set` runs again');
    } else {
      await printWebhookInfo(call, log);
    }
    return 0;
  } catch (err) {
    logError(`Error: ${redact(err instanceof Error ? err.message : String(err))}`);
    return 1;
  }
}

// Only when run as a script (npm run setup-webhook), never on import
if (require.main === module) {
  run(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
