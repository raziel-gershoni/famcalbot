// Which settings a save changed, by field name only: the settings_changed activity row
// never carries a value (a location or a rule is the user's own text).

import { reminderTimeOf } from './reminder-time';

/**
 * The names of the fields in `update` (undefined = "leave as it is") whose value differs from
 * `before`, in the order they appear in `update`. null and undefined count as the same, arrays
 * compare by content, and reminderTime is compared as the user reads it (unset = 09:00).
 */
export function changedSettingFields(before: Record<string, unknown>, update: Record<string, unknown>): string[] {
  const same = (field: string, a: unknown, b: unknown): boolean =>
    field === 'reminderTime' ? reminderTimeOf({ reminderTime: a as string | null }) === reminderTimeOf({ reminderTime: b as string | null })
      : JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return Object.entries(update)
    .filter(([field, value]) => value !== undefined && !same(field, before[field], value))
    .map(([field]) => field);
}
