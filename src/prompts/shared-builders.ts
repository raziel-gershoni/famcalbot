/**
 * Shared Prompt Builder Functions
 * Consolidates common logic used across calendar-summary and week-lookahead prompts
 */

interface CalendarRule {
  calendarName: string;
  rule?: string;
}

/**
 * Build global rules section with provided header
 * Used in both calendar-summary and week-lookahead prompts (6 files)
 */
export function buildGlobalRulesSection(
  globalRules: string[] | undefined,
  header: string
): string {
  if (!globalRules || globalRules.length === 0) return '';

  const rules = globalRules
    .filter(r => r.trim())
    .map((rule, i) => `${i + 1}. ${rule}`)
    .join('\n');

  if (!rules) return '';

  return `
${header}
${rules}`;
}

/**
 * Build calendar-specific rules section with provided header
 * Used in calendar-summary prompts (3 files)
 */
export function buildCalendarRulesSection(
  calendarRules: CalendarRule[] | undefined,
  header: string
): string {
  if (!calendarRules || calendarRules.length === 0) return '';

  const rules = calendarRules
    .filter(r => r.rule?.trim())
    .map(r => `- **${r.calendarName}**: ${r.rule}`)
    .join('\n');

  if (!rules) return '';

  return `
${header}
${rules}`;
}

/**
 * Labels for date info section, varies by language
 */
export interface DateInfoLabels {
  header: string;
  currentDate: string;
  summaryDate: string;
  hebrewDate: string;
  roshChodesh: string;
  yes: string;
  no: string;
}

/**
 * Build date info section with localized labels
 * Used in calendar-summary prompts (3 files)
 */
export function buildDateInfoSection(
  currentGregorianDate: string,
  summaryGregorianDate: string,
  culture: string | undefined,
  summaryHebrewDate: string,
  isRoshChodesh: boolean,
  labels: DateInfoLabels
): string {
  let dateInfo = `**${labels.header}**
- ${labels.currentDate}: ${currentGregorianDate}
- ${labels.summaryDate}: ${summaryGregorianDate}`;

  if (culture === 'jewish') {
    dateInfo += `
- ${labels.hebrewDate}: ${summaryHebrewDate}
- ${labels.roshChodesh}: ${isRoshChodesh ? labels.yes : labels.no}`;
  }

  return dateInfo;
}
