/**
 * "Address me as" (User.gender): the closed set of two, for every input that sets it: Settings (app/api/settings), the
 * sign-up on famcal.bot (src/services/web-signin/signup.ts) and the question a new chat account gets
 * (src/services/address-choice.ts). Anything else (null, '', 'other', another case, a number) is refused, never stored.
 * Client-safe: no import.
 */
export type Gender = 'male' | 'female';

export const isGender = (value: unknown): value is Gender => value === 'male' || value === 'female';
