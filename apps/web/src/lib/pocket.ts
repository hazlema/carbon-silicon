/** "Pocket" = a phone: narrow, or a touch screen held sideways. The table page goes full screen there (M5a). */
export const POCKET_QUERY = '(max-width: 640px), (pointer: coarse) and (max-height: 500px)';

/** The same rule as POCKET_QUERY, for tests and for callers that know the numbers. */
export function isPocket(width: number, height: number, coarse: boolean): boolean {
  return width <= 640 || (coarse && height <= 500);
}
