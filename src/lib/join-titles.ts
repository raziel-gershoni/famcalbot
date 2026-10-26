// How a day's holiday titles are joined in one line: "Chanukah: 8 Candles, Rosh Chodesh Tevet".
// One definition for the calendar home (holidayTitles) and the bot's summaries (weekParashaFor).
// A plain comma in every language: Intl.ListFormat's "unit" list puts only a space between items in
// Russian ("Глава Ваякгель Шаббат Шкалим"). Client-safe and pure.

export function joinTitles(titles: readonly string[]): string {
  return titles.join(', ');
}
