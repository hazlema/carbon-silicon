import { fileURLToPath } from 'node:url';
import { LiveText } from '@cs/shared/live-text';

/** Where a bot's instructions live: Markdown in apps/bots/instructions, sent to the model as written. */
export const instructionsPath = (file: string) => fileURLToPath(new URL(`../instructions/${file}`, import.meta.url));

/**
 * An instructions file the bots re-read while running, so a character or the Bouncer's standards can
 * change without a restart. A bot never starts without them: a missing or blank file stops start-up.
 */
export async function instructions(file: string): Promise<LiveText> {
  const path = instructionsPath(file);
  const text = new LiveText({ path, fallback: '' });
  if (!(await text.get()).trim()) throw new Error(`${path} is missing or blank; the bots won't talk without their instructions.`);
  return text;
}
