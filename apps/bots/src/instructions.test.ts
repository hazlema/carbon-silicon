import { afterAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { instructions, instructionsPath } from './instructions';

const scratch = instructionsPath('zz-test-blank.md');
afterAll(() => rm(scratch, { force: true }));

describe('instructions', () => {
  test('every resident has its instructions written', async () => {
    for (const file of ['house-rules.md', 'old-iron.md', 'bouncer.md']) {
      expect((await (await instructions(file)).get()).trim().length).toBeGreaterThan(100);
    }
  });
  test('a missing or blank file stops start-up', async () => {
    await expect(instructions('nope.md')).rejects.toThrow('missing or blank');
    await Bun.write(scratch, '\n');
    await expect(instructions('zz-test-blank.md')).rejects.toThrow('missing or blank');
  });
});
