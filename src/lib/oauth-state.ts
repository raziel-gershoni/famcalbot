/**
 * Google OAuth state tokens. POST /api/oauth/start creates them only for a user that
 * verifyUserAuth proved, and stores that user's DB id; the prefix marks this kind of
 * state. The callback refuses a state without it: those were created by the old
 * /refresh-token page for any user_id, with no credential (they expire in 10 minutes).
 */
export const OAUTH_STATE_PREFIX = 'u1_';

/** How long a consent's state is honoured. The calendars page's consent wait ends with it. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
