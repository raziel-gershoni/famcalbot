/**
 * A sign-in's one-time checks (web sign-in spec §3): Telegram's and Google's state, nonce and PKCE verifier, and the
 * email flow's address key. They live in Redis for 10 minutes and are bound to the browser that started the sign-in
 * by the famcal_signin cookie: a random id, whose sha256 names the record, so the Redis key never holds the cookie.
 *
 * - An OIDC callback takes its record (GETDEL): used once, whatever happens next. A callback without the cookie, or
 *   whose record is gone, gets null; the route then says to start again in the browser you began in. A record of
 *   another kind is left alone (a GET, no GETDEL) and also gets null: it is this browser's newer sign-in of another
 *   way, started in another tab, and its own step still finishes it.
 * - The email flow is read (GET) on each try, since a wrong code doesn't end it; the right code takes it.
 * - A sign-up (web sign-up spec 2026-11-03 §3.4) is a flow of its own, 'signup': the verified way waiting for the
 *   person's name and the Terms, started under a new cookie by the step that proved the way. /signup reads it (GET,
 *   peekFlow) and Create account takes it (GETDEL, takeFlow).
 * - Any kind may carry the partner invite the sign-in began on (a 64-hex pairing token, cleanInviteToken in
 *   src/lib/invite-token.ts, read back only through inviteOf), never a return URL.
 * - The cookie is httpOnly, Secure, SameSite=Lax (Telegram and Google return with a top-level GET), path /api/auth.
 *
 * Nothing here logs the cookie, a state, a nonce, a verifier, an address key, a sign-up's subject or address, or an
 * invite.
 */

import crypto from 'crypto';
import type { NextRequest, NextResponse } from 'next/server';
import { redis } from '../../utils/redis';
import { REDIS_KEYS } from '../../config/redis-keys';
import { cleanInviteToken } from '../../lib/invite-token';

export const SIGNIN_COOKIE_NAME = 'famcal_signin';
const FLOW_TTL_SEC = 10 * 60;
const COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/api/auth' };
/** A flow id: 32 random bytes, base64url. Anything else in the cookie is not ours and reaches no Redis call. */
const FLOW_ID = /^[A-Za-z0-9_-]{43}$/;

export type OidcFlow = {
  kind: 'telegram' | 'google' | 'add-google';
  state: string;
  nonce: string;
  codeVerifier: string;
  locale: string;
  /** add-google only: the account the Google sign-in way is added to. */
  userId?: number;
  /** The partner invite this sign-in came from (cleanInviteToken's form, read back by inviteOf), carried to its finish. */
  invite?: string;
  /** When the sign-in began (epoch ms, set by startFlow): a flow put back keeps the time it had left. */
  startedAt?: number;
};
export type EmailFlow = { kind: 'email'; emailKey: string; locale: string; invite?: string; startedAt?: number };
/**
 * A sign-up waiting for its name and the Terms (web sign-up spec §3.4): the way that proved who the person is, its
 * subject (Google's sub, or the normalised address an email code proved), the address to show, the language the
 * sign-in began in, and the invite it came from.
 */
export type SignUpFlow = {
  kind: 'signup';
  way: 'google' | 'email';
  subject: string;
  address: string;
  locale: string;
  invite?: string;
  startedAt?: number;
};
export type SignInFlow = OidcFlow | EmailFlow | SignUpFlow;

const recordKey = (flowId: string) => REDIS_KEYS.signinFlow(crypto.createHash('sha256').update(flowId).digest('hex'));

/** The record as a flow, or null when it isn't one (an old or foreign shape). */
function asFlow(value: unknown): SignInFlow | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.locale !== 'string') return null;
  if (v.kind === 'email') {
    return typeof v.emailKey === 'string' ? { kind: 'email', emailKey: v.emailKey, locale: v.locale, ...inviteOf(v), ...startedAtOf(v) } : null;
  }
  if (v.kind === 'signup') {
    if ((v.way !== 'google' && v.way !== 'email') || typeof v.subject !== 'string' || typeof v.address !== 'string') return null;
    return { kind: 'signup', way: v.way, subject: v.subject, address: v.address, locale: v.locale, ...inviteOf(v), ...startedAtOf(v) };
  }
  if (v.kind !== 'telegram' && v.kind !== 'google' && v.kind !== 'add-google') return null;
  if (typeof v.state !== 'string' || typeof v.nonce !== 'string' || typeof v.codeVerifier !== 'string') return null;
  if (v.kind === 'add-google' && typeof v.userId !== 'number') return null;
  return {
    kind: v.kind,
    state: v.state,
    nonce: v.nonce,
    codeVerifier: v.codeVerifier,
    locale: v.locale,
    ...(typeof v.userId === 'number' ? { userId: v.userId } : {}),
    ...inviteOf(v),
    ...startedAtOf(v),
  };
}

const startedAtOf = (v: Record<string, unknown>) => (typeof v.startedAt === 'number' && Number.isFinite(v.startedAt) ? { startedAt: v.startedAt } : {});

/**
 * The invite a stored record carries, when it is a clean token (cleanInviteToken); anything else is dropped, never
 * echoed. The one reader of `invite` from a record: every flow kind that carries one spreads it.
 */
export function inviteOf(v: Record<string, unknown>): { invite?: string } {
  const invite = cleanInviteToken(v.invite);
  return invite ? { invite } : {};
}

/** The flow id in the request's famcal_signin cookie, or null (logged: which browser it was is the person's question). */
function flowIdOf(request: NextRequest, step: string): string | null {
  const id = request.cookies.get(SIGNIN_COOKIE_NAME)?.value;
  if (!id || !FLOW_ID.test(id)) {
    console.warn(`[signin-flow] ${step}: no famcal_signin cookie (another browser, or over 10 minutes)`);
    return null;
  }
  return id;
}

/** Seconds a flow begun at `startedAt` (epoch ms) has left of its 10 minutes: never more than all of them, 0 or less when over. */
export function flowTimeLeftSec(startedAt: number, now: number): number {
  return Math.min(FLOW_TTL_SEC, Math.ceil(FLOW_TTL_SEC - (now - startedAt) / 1000));
}

/**
 * Stores `flow` under a new random id and sets that id as this response's famcal_signin cookie, for 10 minutes from
 * the sign-in's start: a flow with no `startedAt` is new (now), one that has it (put back by the callback after a
 * state mismatch) keeps the time it had left, so a stale tab's answers cannot stretch it. A flow with no time left is
 * not stored (the person starts again). A second sign-in in the same browser replaces the cookie; the first record
 * expires unused. Throws when Redis fails (the route catches it and answers that sign-in failed).
 */
export async function startFlow(response: NextResponse, flow: SignInFlow): Promise<void> {
  const startedAt = flow.startedAt ?? Date.now();
  const flowTtlSec = flowTimeLeftSec(startedAt, Date.now());
  if (flowTtlSec <= 0) {
    console.warn(`[signin-flow] a ${flow.kind} sign-in had no time left to keep`);
    return;
  }
  const flowId = crypto.randomBytes(32).toString('base64url');
  await redis.set(recordKey(flowId), { ...flow, startedAt }, { ex: flowTtlSec });
  response.cookies.set(SIGNIN_COOKIE_NAME, flowId, { ...COOKIE_OPTIONS, maxAge: flowTtlSec });
  console.info(`[signin-flow] started a ${flow.kind} sign-in${'userId' in flow && flow.userId !== undefined ? ` for user ${flow.userId}` : ''}`);
}

/**
 * Takes this browser's flow (GETDEL: used once) when it is one of `kinds`; null without the cookie, when the record
 * is gone (used, or over 10 minutes), or when it is another kind. A flow of another kind is only read (GET), never
 * used up: the browser's latest sign-in may be another way's, started in a second tab, and it must still finish there
 * (review focus RF1). Only a flow of a matching kind is then taken, so it is still used once.
 */
export async function takeFlow(request: NextRequest, kinds: SignInFlow['kind'][]): Promise<SignInFlow | null> {
  const step = kinds.join('/');
  const flowId = flowIdOf(request, step);
  if (!flowId) return null;
  const key = recordKey(flowId);
  const seen = asFlow(await redis.get(key));
  if (seen && !kinds.includes(seen.kind)) {
    console.warn(`[signin-flow] ${step}: the cookie's sign-in is a ${seen.kind} one; refused and left for its own step`);
    return null;
  }
  const flow = seen ? asFlow(await redis.getdel(key)) : null;
  if (!flow || !kinds.includes(flow.kind)) {
    console.warn(`[signin-flow] ${step}: no sign-in under the cookie (used, or over 10 minutes)`);
    return null;
  }
  return flow;
}

/**
 * Reads this browser's email flow or sign-up without using it up (GET): a wrong code leaves the email flow for the
 * next try, and /signup reads the sign-up as often as it is opened (Create account takes it, with takeFlow).
 */
export async function peekFlow(request: NextRequest, kind: 'email'): Promise<EmailFlow | null>;
export async function peekFlow(request: NextRequest, kind: 'signup'): Promise<SignUpFlow | null>;
export async function peekFlow(request: NextRequest, kind: 'email' | 'signup'): Promise<EmailFlow | SignUpFlow | null> {
  const flowId = flowIdOf(request, kind);
  if (!flowId) return null;
  const flow = asFlow(await redis.get(recordKey(flowId)));
  if (!flow || flow.kind !== kind) {
    console.warn(`[signin-flow] ${kind}: no ${kind === 'email' ? 'email sign-in' : 'sign-up'} under the cookie (used, or over 10 minutes)`);
    return null;
  }
  return flow as EmailFlow | SignUpFlow;
}

/** Clears the famcal_signin cookie (same path and flags, Max-Age 0), once a flow is finished or refused. */
export function clearFlowCookie(response: NextResponse): void {
  response.cookies.set(SIGNIN_COOKIE_NAME, '', { ...COOKIE_OPTIONS, maxAge: 0 });
}
