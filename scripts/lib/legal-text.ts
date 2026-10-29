// The Privacy and Terms pages' text as the smokes read it (plan docs/superpowers/plans/2026-10-29-public-website.md,
// Task 5): it lives in messages (legal.privacy, legal.terms), one string per heading, paragraph and list item. Until the
// owner-approved wording replaces it, every string is a marked placeholder; a check of what the text must say arms
// itself the moment the placeholder is gone. scripts/lib/ is not a smoke (ci-smokes.sh runs scripts/smoke-*.ts only).

/** The marker every placeholder string of the legal pages carries. */
export const LEGAL_PLACEHOLDER = 'legal text pending review';

function strings(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (!node || typeof node !== 'object') return [];
  return Object.values(node as Record<string, unknown>).flatMap(strings);
}

/** A legal page's whole text in one language: every string of legal.<doc>, in order, joined by spaces. */
export function legalText(messages: Record<string, unknown>, doc: 'privacy' | 'terms'): string {
  return strings((messages.legal as Record<string, unknown> | undefined)?.[doc]).join(' ');
}

/** Whether a legal page's wording is still the placeholder (in any language). */
export function legalPending(texts: string[]): boolean {
  return texts.some((text) => text.includes(LEGAL_PLACEHOLDER));
}
