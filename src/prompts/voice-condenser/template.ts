/**
 * Voice Condenser Template Helpers
 * Shared logic for building voice condenser prompts across languages
 */

export interface FamilyContextLabels {
  userName: string;
  spouseLabel: string;
  kidsLabel: string;
}

/**
 * Build family context section with localized labels
 * @param userName - The user's name
 * @param spouseName - Optional spouse name
 * @param hasKidsCalendars - Whether user has kids calendars
 * @param labels - Language-specific labels
 */
export function buildFamilyContext(
  userName: string,
  spouseName: string | undefined,
  hasKidsCalendars: boolean,
  labels: FamilyContextLabels
): string {
  let context = `${labels.userName} ${userName}.`;
  if (spouseName) {
    context += ` ${labels.spouseLabel} ${spouseName}.`;
  }
  if (hasKidsCalendars) {
    context += ` ${labels.kidsLabel}`;
  }
  return context;
}

/**
 * Build rules section for voice condenser
 * @param globalRules - User's custom rules
 * @param header - Language-specific header
 */
export function buildRulesSection(
  globalRules: string[] | undefined,
  header: string
): string {
  if (!globalRules?.length) return '';

  const rules = globalRules.map((r, i) => `${i + 1}. ${r}`).join('\n');
  return `\n**${header}**\n${rules}\n`;
}
