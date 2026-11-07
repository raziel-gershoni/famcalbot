/**
 * Any other path under /api/v1/: 404 NOT_FOUND in the API's own error shape (spec
 * docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3.7). /api/v1/shabbat and /api/v1/day are their own routes.
 */

import { notFound, preflight } from '@/src/lib/api-v1/handle';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(): Response {
  return notFound();
}

export function OPTIONS(request: Request): Promise<Response> {
  return preflight(request);
}
