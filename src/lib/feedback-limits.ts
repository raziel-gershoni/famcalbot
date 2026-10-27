/**
 * What a feedback message may be: how short and how long (counted on the trimmed text), and how many a person can send in a day.
 * /api/feedback enforces them; the Feedback screen mirrors them (its count, its Send button and the field's limit), so a change is made here once.
 */
export const FEEDBACK_LIMITS = { minLength: 10, maxLength: 1000, perDay: 3 } as const;
