import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const port = Number(process.env.E2E_PORT || 3110);
const baseURL = `http://127.0.0.1:${port}`;
const database = path.resolve(process.env.E2E_DATABASE_PATH || 'output/e2e/game.sqlite');

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL, ...devices['Desktop Chrome'], channel: process.env.E2E_BROWSER_CHANNEL || undefined, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: `npm run start -- --port ${port}`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { DATABASE_PATH: database, APP_URL: baseURL, NEXT_TELEMETRY_DISABLED: '1' },
  },
});
