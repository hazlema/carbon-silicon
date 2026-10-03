import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnvFile, readEnvFile } from './env-file';

const dir = await mkdtemp(join(tmpdir(), 'cs-envfile-'));
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('parseEnvFile', () => {
  test('reads KEY=value lines', () => {
    expect(parseEnvFile('A=1\nB=two words\n')).toEqual({ A: '1', B: 'two words' });
  });
  test('accepts a leading export', () => {
    expect(parseEnvFile('export A=1\nexport   B=2')).toEqual({ A: '1', B: '2' });
  });
  test('skips blank lines and comments', () => {
    expect(parseEnvFile('\n# a comment\n   \n  # indented\nA=1\r\n')).toEqual({ A: '1' });
  });
  test('strips single and double quotes', () => {
    expect(parseEnvFile(`A='x y'\nB="p q"`)).toEqual({ A: 'x y', B: 'p q' });
  });
  test('inside double quotes \\n is a newline; single quotes stay literal', () => {
    expect(parseEnvFile('A="one\\ntwo"\nB=\'one\\ntwo\'')).toEqual({ A: 'one\ntwo', B: 'one\\ntwo' });
  });
  test('quoted values keep # and spaces', () => {
    expect(parseEnvFile('A=" keep # this "')).toEqual({ A: ' keep # this ' });
  });
  test('unquoted values are trimmed and a " #" starts a trailing comment', () => {
    expect(parseEnvFile('A=  spaced  \nB=url#frag\nC=val # note\nD=')).toEqual({ A: 'spaced', B: 'url#frag', C: 'val', D: '' });
  });
  test('keeps = inside values', () => {
    expect(parseEnvFile('A=x=y')).toEqual({ A: 'x=y' });
  });
  test('ignores lines whose key is not a valid name', () => {
    expect(parseEnvFile('1A=x\nA-B=y\n=z\njust text\n A B=q\nOK_1=fine')).toEqual({ OK_1: 'fine' });
  });
});

describe('readEnvFile', () => {
  test('is null when the file does not exist', async () => {
    expect(await readEnvFile(join(dir, 'nope.env'))).toBeNull();
  });
  test('parses an existing file', async () => {
    const p = join(dir, 'x.env');
    await Bun.write(p, 'A=1\n');
    expect(await readEnvFile(p)).toEqual({ A: '1' });
  });
});
