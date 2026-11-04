/**
 * Join (web sign-up spec 2026-11-03 §2.9, §3.6): one account (T) takes in a FamCal account made on famcal.bot (W).
 *
 * A join is offered only where the person has just proved, in a flow they started from T, that they hold W's way:
 * Settings' Add Google (finishAddGoogle, after Google's answer) and Add email (the confirm route, after the right code)
 * find the way held by W. Anything less would let someone talk a person into joining a stranger's account into theirs.
 * It is offered only for a W with no chat (no Telegram, no WhatsApp) that isn't T's partner, with neither account
 * suspended or banned; otherwise the caller answers 6b's `taken`.
 *
 * The question lists what moves, from previewMerge: the merge's own rules (mergePlan, account-linking.ts) read now, so
 * it can't promise what the merge won't do. Its id (16 random bytes, base64url) is kept 10 minutes in Redis only as
 * its sha256, bound to T, and used once (GETDEL): an answer from another account uses it up and joins nothing.
 * runJoin checks everything again before it merges, then T gets the notice for the way it gained (sendSignInNotice),
 * and W's sessions end with W (its row is gone). No log line holds the id, an address or a name.
 *
 * account-linking is loaded when a join runs, as notice.ts loads the bot: it pulls in the Telegram client.
 */

import crypto from 'crypto';
import { redis } from '../../utils/redis';
import { REDIS_KEYS } from '../../config/redis-keys';
import { signInRefusal } from '../../lib/web-session';
import { hasChat } from '../../lib/has-chat';
import type { UserConfig } from '../../types';
import type { MergePlan } from '../account-linking';
import { getUserById } from '../user-service';
import { invalidateFeatureAccessCache } from '../subscription-service';
import { identityHolder, listSignInMethods, type IdentityKind, type SignInMethodsView } from './identities';
import { sendSignInNotice } from './notice';

const JOIN_TTL_SEC = 10 * 60;
/** 16 random bytes as base64url */
const JOIN_ID = /^[A-Za-z0-9_-]{22}$/;

/** What the question shows: W's name, when it was made, and what the merge would do. */
export type JoinSummary = { name: string; createdAt: string; plan: MergePlan };

type JoinRecord = {
  tUserId: number;
  wUserId: number;
  /** The way the person proved: the one T gains, which the notice names */
  way: { kind: IdentityKind; subject: string; address: string };
  summary: JoinSummary;
};

const keyOf = (joinId: string) => REDIS_KEYS.signinJoin(crypto.createHash('sha256').update(joinId).digest('hex'));

/** Why W can't join T, or null. Read the same way when the question is made and when it is answered. */
async function joinRefusal(t: UserConfig, w: UserConfig | null, way: JoinRecord['way']): Promise<string | null> {
  if (!w) return 'the other account is gone';
  if (w.id === t.id) return 'the same account';
  if (hasChat(w)) return 'the other account has a chat';
  if (w.pairingId !== null && w.pairingId === t.pairingId) return 'the two are partners';
  if ((await identityHolder(way.kind, way.subject)) !== w.id) return `the ${way.kind} way is no longer the other account's`;
  const refusals = await Promise.all([signInRefusal(t), signInRefusal(w)]);
  if (refusals[0]) return `this account is ${refusals[0]}`;
  if (refusals[1]) return `the other account is ${refusals[1]}`;
  return null;
}

function readRecord(raw: unknown): JoinRecord | null {
  if (!raw) return null;
  const record = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Partial<JoinRecord>;
  return typeof record.tUserId === 'number' && typeof record.wUserId === 'number' && record.way && record.summary ? (record as JoinRecord) : null;
}

/**
 * The Join question for T, after T proved `way`, which W holds: its one-time id and what it shows, or null when there
 * is no join to offer (W has a chat, is T's partner, is gone, or either account is suspended or banned). Each null is
 * logged with the reason.
 */
export async function offerJoin(tUser: UserConfig, wUserId: number, way: JoinRecord['way']): Promise<{ joinId: string; summary: JoinSummary } | null> {
  const w = await getUserById(wUserId);
  const refusal = await joinRefusal(tUser, w, way);
  if (refusal || !w) {
    console.warn(`[join] user ${tUser.id}: no join offered for user ${wUserId} (${refusal})`);
    return null;
  }
  const { previewMerge } = await import('../account-linking');
  const summary: JoinSummary = { name: w.name, createdAt: w.createdAt.toISOString(), plan: await previewMerge(w.id, tUser.id) };
  const joinId = crypto.randomBytes(16).toString('base64url');
  const record: JoinRecord = { tUserId: tUser.id, wUserId: w.id, way, summary };
  await redis.set(keyOf(joinId), JSON.stringify(record), { ex: JOIN_TTL_SEC });
  console.log(`[join] user ${tUser.id}: offered to join user ${w.id} (${way.kind})`);
  return { joinId, summary };
}

/** The question an id names, for T only, without using it up (the add-Google page shows it); null for a late, used, bad or another account's id. */
export async function peekJoin(tUserId: number, joinId: unknown): Promise<JoinSummary | null> {
  if (typeof joinId !== 'string' || !JOIN_ID.test(joinId)) return null;
  const record = readRecord(await redis.get(keyOf(joinId)));
  return record && record.tUserId === tUserId ? record.summary : null;
}

/**
 * The answer Join: the question is used up (GETDEL) whoever answers. 'expired' for a late, used or bad id; 'refused'
 * for another account's id, or when a check fails now (W got a chat, the two paired, a way moved, a suspension, a ban,
 * or the merge refused). Then W merges into T, T's feature access is read again, T gets the notice for the way it
 * gained, and the answer is T's ways now.
 */
export async function runJoin(tUserId: number, joinId: unknown): Promise<{ ok: true; methods: SignInMethodsView } | { ok: false; error: 'expired' | 'refused' }> {
  if (typeof joinId !== 'string' || !JOIN_ID.test(joinId)) {
    console.warn(`[join] user ${tUserId}: a Join answer with no valid question id`);
    return { ok: false, error: 'expired' };
  }
  const record = readRecord(await redis.getdel(keyOf(joinId)));
  if (!record) {
    console.warn(`[join] user ${tUserId}: the Join question expired or was used`);
    return { ok: false, error: 'expired' };
  }
  if (record.tUserId !== tUserId) {
    console.warn(`[join] user ${tUserId}: answered a Join question made for user ${record.tUserId}; used up, nothing joined`);
    return { ok: false, error: 'refused' };
  }
  const [t, w] = await Promise.all([getUserById(tUserId), getUserById(record.wUserId)]);
  const refusal = t ? await joinRefusal(t, w, record.way) : 'this account is gone';
  if (refusal || !t) {
    console.warn(`[join] user ${tUserId}: Join of user ${record.wUserId} refused (${refusal})`);
    return { ok: false, error: 'refused' };
  }
  const { mergeAccounts, MergeRefusedError } = await import('../account-linking');
  try {
    await mergeAccounts(record.wUserId, tUserId);
  } catch (error) {
    if (!(error instanceof MergeRefusedError)) throw error;
    console.warn(`[join] user ${tUserId}: the merge refused user ${record.wUserId}: ${error.message}`);
    return { ok: false, error: 'refused' };
  }
  console.log(`[join] user ${record.wUserId} joined into user ${tUserId}`);
  await invalidateFeatureAccessCache(tUserId);
  const after = (await getUserById(tUserId)) ?? t;
  await sendSignInNotice(after, { kind: record.way.kind, address: record.way.address, via: 'joined' });
  return { ok: true, methods: await listSignInMethods(after) };
}
