/**
 * GET /api/v1/shabbat: the Shabbat and Yom Tov blocks of a range of days at a place, for the owner's other apps (spec
 * docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3.1 a; reference docs/api/jewish-times-v1.md). The key, the
 * origin, the rate, the parameters and the answer are all handleApiV1's.
 */

import { handleApiV1, preflight } from '@/src/lib/api-v1/handle';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: Request): Promise<Response> {
  return handleApiV1(request, 'shabbat');
}

export function OPTIONS(request: Request): Promise<Response> {
  return preflight(request);
}
