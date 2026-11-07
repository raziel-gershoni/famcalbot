/**
 * GET /api/v1/day: one day's zmanim, halachic hours, holidays and Hebrew date at a place, for the owner's other apps (spec
 * docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3.1 b; reference docs/api/jewish-times-v1.md). Everything is
 * handleApiV1's.
 */

import { handleApiV1, preflight } from '@/src/lib/api-v1/handle';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: Request): Promise<Response> {
  return handleApiV1(request, 'day');
}

export function OPTIONS(request: Request): Promise<Response> {
  return preflight(request);
}
