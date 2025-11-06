declare module 'hebcal' {
  export class HDate {
    constructor(date?: Date | number);
    getDate(): number;
    getMonthName(locale?: string): string;
    getFullYear(): number;
  }

  export const months: any;
}
