// How the admin panel reads an activity row's metadata, in everyone's activity log and in a
// person's profile. The row's action is its label; this is the short detail beside it. The activity rows the bot
// writes for commands, settings, errors and connections read as words; any other row keeps
// the raw JSON it always showed, cut to `max` characters.

const DEFAULT_MAX = 60;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The detail line for one activity row, or '' when it has no metadata. */
export function activityDetail(action: string, metadata: Record<string, unknown> | null | undefined, max: number = DEFAULT_MAX): string {
  if (!metadata || Object.keys(metadata).length === 0) return '';
  let words = '';
  switch (action) {
    case 'command_completed':
      words = [text(metadata.command), text(metadata.platform)].filter(Boolean).join(' · ');
      break;
    case 'settings_changed':
      words = Array.isArray(metadata.changed_fields) ? metadata.changed_fields.filter((f) => typeof f === 'string').join(', ') : '';
      break;
    case 'user_error_shown':
      words = [text(metadata.error_type), text(metadata.command)].filter(Boolean).join(' · ');
      break;
    case 'calendar_connected':
      words = text(metadata.provider);
      break;
    case 'calendar_disconnected':
      words = [text(metadata.provider), `${Number(metadata.copies_deleted) || 0} copies deleted`, `${Number(metadata.copies_left) || 0} left`, metadata.revoked === true ? 'revoked' : 'not revoked'].filter(Boolean).join(' · ');
      break;
  }
  const detail = words || JSON.stringify(metadata);
  return detail.length > max ? `${detail.substring(0, max)}...` : detail;
}
