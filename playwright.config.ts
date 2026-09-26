import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.e2e\.ts$/,
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3100',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'bun e2e/serve.ts',
    url: 'http://127.0.0.1:3100/api',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
