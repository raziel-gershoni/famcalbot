// The words of a reminder by zman, in one place (the copy is calendarHome.zmanim.*): the editor's picker names a zman
// with its opinion ("Latest time for Shema (GRA)"), and the home's row and the item sheet word the whole rule
// ("10 min before the latest time for Shema (GRA)"). Names follow the owner's luach terms; a zman's name and its
// opinion are always together. A name after "before" and "after" is its own copy (calendarHome.zmanim.namesAfter):
// Russian declines it.
//
// Client-safe and pure apart from the translation function it is given.

import type { ZmanOpinion, ZmanSpecValue } from './zman-spec';

/**
 * A translator over calendarHome, by its shape: useTranslations('calendarHome') in the Mini App, getTranslations({ locale,
 * namespace: 'calendarHome' }) on a server page and createTranslator in the bot all fit.
 */
export type ZmanWordsT = (key: string, values?: Record<string, string | number>) => string;

/** A zman's name with the opinion it is counted by, as a list names it. */
export function zmanName(t: ZmanWordsT, key: string, opinion: ZmanOpinion | null, afterOffset = false): string {
  const name = t(afterOffset ? `zmanim.namesAfter.${key}` : `zmanim.names.${key}`);
  return opinion ? t('zmanim.withOpinion', { name, opinion: t(`zmanim.opinions.${opinion}`) }) : name;
}

/**
 * A rule in words: "10 min before the latest time for Shema (GRA)", "Plag hamincha (Halacha Berura)" with no offset,
 * "2 halachic hours after sunrise". `opinion` is the one the person's set names the zman with (the DTO's and the
 * editor info's); it is ignored for halachic hours.
 */
export function zmanRuleWords(t: ZmanWordsT, spec: ZmanSpecValue, opinion: ZmanOpinion | null): string {
  const minutes = Math.abs(spec.offsetMin);
  if (minutes === 0) return 'zman' in spec ? zmanName(t, spec.zman, opinion) : t('zmanim.hours', { count: spec.halachicHours });
  const name = 'zman' in spec ? zmanName(t, spec.zman, opinion, true) : t('zmanim.hoursAfter', { count: spec.halachicHours });
  return t(spec.offsetMin < 0 ? 'zmanim.before' : 'zmanim.after', { minutes, name });
}
