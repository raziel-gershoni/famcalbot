/**
 * Google OAuth state tokens. POST /api/oauth/start creates them only for a user that
 * verifyUserAuth proved, and stores that user's DB id; the prefix marks this kind of
 * state. The callback refuses a state without it: those were created by the old
 * /refresh-token page for any user_id, with no credential (they expire in 10 minutes).
 */
export const OAUTH_STATE_PREFIX = 'u1_';

/** How long a consent's state is honoured. The calendars page's consent wait ends with it. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * The errors /api/refresh-token (Google's redirect URI) puts on the callback when Google came back without a code or a
 * state of its own making: the callback reads them as an expired link. Google's own errors pass through as they are
 * (access_denied: the person said no; anything else: Google refused the connection).
 */
export const OAUTH_RETURN_MISSING_CODE = 'missing_code';
export const OAUTH_RETURN_MISSING_STATE = 'missing_state';

/** A value from the query, as the logs may hold it: cut short and quoted, so it can't break a log line. */
export const loggable = (value: string): string => JSON.stringify(value.slice(0, 60));
