// The one Month screen's layout rules (responsive home, release 2; spec §1–§4): the two
// media queries, the upright split's heights, a square's size class and the month under
// a scroll. Pure and client-safe: no React, no window, no imports.

/** Wide: the Month sits side by side with its day list (spec §1). */
export const WIDE_QUERY = '(min-width: 600px) and (orientation: landscape)';
/** Short: the header drops a line (spec §1). */
export const SHORT_QUERY = '(max-height: 520px) and (orientation: landscape)';

/** The split's drag handle, its touch padding on each side, and the movement that still counts as a tap. */
export const HANDLE_PX = 22;
export const HANDLE_TOUCH_PX = 11;
export const HANDLE_TAP_PX = 12;
/** The day list never gets less than this when the split is collapsed. */
export const LIST_MIN_PX = 120;
/** A week row's least height, and its least on a short screen. */
export const ROW_MIN_PX = 44;
export const ROW_SHORT_MIN_PX = 36;
/** The list's strip left under a grown month. */
export const PEEK_PX = 44;
/** The month's week rows in the upright split. */
export const SPLIT_ROWS = 6;
/** How long a settle (a snap or a handle release) takes. */
export const SETTLE_MS = 220;

export interface SplitHeights {
  rowPx: number;
  scrollerPx: number;
  listPx: number;
}

const NONE: SplitHeights = { rowPx: 0, scrollerPx: 0, listPx: 0 };

const positive = (n: number) => Number.isFinite(n) && n > 0;

/**
 * The upright split's heights in a region `h` px tall under `chrome` px of bar and
 * weekday line, for cells `cellWidth` px wide. The region runs down to the screen's bottom
 * edge, the bottom safe area (`endInset`, the home indicator) included: the list scrolls under
 * it and pads its own end by it. Collapsed: square-ish rows (0.9 of the width) that leave the
 * list at least LIST_MIN_PX (the safe area counts), the rows shrinking toward
 * ROW_SHORT_MIN_PX first. Grown: the month takes all but the handle and the list's peek,
 * PEEK_PX clear of the safe area. Anything not finite and positive gives zeros (an inset, 0).
 */
export function splitHeights(h: number, chrome: number, cellWidth: number, grown: boolean, endInset = 0): SplitHeights {
  if (!positive(h) || !positive(cellWidth) || !Number.isFinite(chrome)) return { ...NONE };
  if (grown) {
    const inset = positive(endInset) ? endInset : 0;
    const scrollerPx = Math.max(0, h - chrome - HANDLE_PX - PEEK_PX - inset);
    return { rowPx: Math.floor(scrollerPx / SPLIT_ROWS), scrollerPx, listPx: PEEK_PX + inset };
  }
  let rowPx = Math.max(ROW_MIN_PX, Math.min(Math.round(cellWidth * 0.9), Math.floor((h * 0.6 - chrome) / SPLIT_ROWS)));
  if (h - chrome - SPLIT_ROWS * rowPx - HANDLE_PX < LIST_MIN_PX) {
    rowPx = Math.max(ROW_SHORT_MIN_PX, Math.floor((h - chrome - HANDLE_PX - LIST_MIN_PX) / SPLIT_ROWS));
  }
  const scrollerPx = SPLIT_ROWS * rowPx;
  return { rowPx, scrollerPx, listPx: Math.max(0, h - chrome - scrollerPx - HANDLE_PX) };
}

export type SquareKind = 'small' | 'medium' | 'large';

export interface SquareSize {
  kind: SquareKind;
  /** The chip lines a large square draws, "+N" included; 0 for small and medium. */
  lines: number;
  big: boolean;
}

/** One chip line's height, and the square's own head, in the normal and the big square. */
export const SQUARE_SLOT_PX = 18;
export const SQUARE_SLOT_BIG_PX = 21;
export const SQUARE_USED_PX = 35;
export const SQUARE_USED_BIG_PX = 41;
export const SQUARE_MAX_LINES = 7;

/**
 * A month square `h` × `w` px: small (a date and a dot) under 60 px high or 44 wide,
 * medium (the date and counts) under 82 px high, else large with as many chip lines as
 * fit, 1 to SQUARE_MAX_LINES; big (110 × 100 or more) uses the roomier type.
 */
export function squareSize(h: number, w: number): SquareSize {
  if (!Number.isFinite(h) || !Number.isFinite(w) || h < 60 || w < 44) return { kind: 'small', lines: 0, big: false };
  if (h < 82) return { kind: 'medium', lines: 0, big: false };
  const big = w >= 110 && h >= 100;
  const used = big ? SQUARE_USED_BIG_PX : SQUARE_USED_PX;
  const slot = big ? SQUARE_SLOT_BIG_PX : SQUARE_SLOT_PX;
  return { kind: 'large', lines: Math.max(1, Math.min(SQUARE_MAX_LINES, Math.floor((h - used) / slot))), big };
}

/** The index of the month under the middle of a pane `paneHeight` tall scrolled to `scrollTop`, of `count` months one pane each. */
export function monthAtScroll(scrollTop: number, paneHeight: number, count: number): number {
  if (!Number.isFinite(scrollTop) || !positive(paneHeight) || !Number.isFinite(count) || count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, Math.floor((scrollTop + paneHeight / 2) / paneHeight)));
}
