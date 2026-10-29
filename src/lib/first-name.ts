/**
 * The name a line uses for a person it speaks of: the first word of their name, else of their English name, null when
 * neither has one. The one rule for "Noa" in "Only Noa can copy these to Google" (the copy rows' ownerName) and in
 * "Noa's calendars" (the Calendars page's heading for the calendars the partner shares). Pure and client-safe.
 */
export function firstNameOf(person: { name?: string | null; englishName?: string | null }): string | null {
  return (person.name || person.englishName || '').trim().split(/\s+/)[0] || null;
}
