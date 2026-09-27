import { describe, expect, test } from 'bun:test';
import { isDevSecret, secretFromEnv } from './secrets';

describe('secretFromEnv', () => {
  const run = (name: 'HOUSE_KEY' | 'ADMIN_KEY', raw: string | undefined, production: boolean) => {
    const warnings: string[] = [];
    return { value: secretFromEnv(name, raw, production, (m) => warnings.push(m)), warnings };
  };

  test('outside production an unset secret falls back to its known dev value, quietly', () => {
    expect(run('HOUSE_KEY', undefined, false)).toEqual({ value: 'dev-house-key', warnings: [] });
    expect(run('ADMIN_KEY', undefined, false)).toEqual({ value: 'dev-admin-key', warnings: [] });
    expect(run('ADMIN_KEY', 'dev-admin-key', false)).toEqual({ value: 'dev-admin-key', warnings: [] });
  });

  test('in production a known dev value counts as unset, with a loud warning naming the variable', () => {
    const house = run('HOUSE_KEY', 'dev-house-key', true);
    expect(house.value).toBeNull();
    expect(house.warnings).toHaveLength(1);
    expect(house.warnings[0]).toContain('HOUSE_KEY');
    const admin = run('ADMIN_KEY', ' dev-admin-key ', true);
    expect(admin.value).toBeNull();
    expect(admin.warnings[0]).toContain('ADMIN_KEY');
    // either dev value, in either variable
    expect(run('ADMIN_KEY', 'dev-house-key', true).value).toBeNull();
  });

  test('in production unset stays unset and a real secret is used as given', () => {
    expect(run('HOUSE_KEY', undefined, true)).toEqual({ value: null, warnings: [] });
    expect(run('HOUSE_KEY', '', true)).toEqual({ value: null, warnings: [] });
    expect(run('ADMIN_KEY', 'q8Zp1-long-random-value', true)).toEqual({ value: 'q8Zp1-long-random-value', warnings: [] });
  });

  test('isDevSecret knows both dev values', () => {
    expect([isDevSecret('dev-house-key'), isDevSecret('dev-admin-key'), isDevSecret('something else')]).toEqual([true, true, false]);
  });
});
