/** A short random tag for building test handles, e.g. `e2e${randomTag()}`. Digits only — unlike
 *  a base-36 tag, it can never accidentally spell something the profanity filter rejects. */
export function randomTag(): string {
  return String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
}
