import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests drive the real app (its web build) against a real PiVault server.
 *
 *   1. docker compose -f ../deploy/docker-compose.dev.yml up -d --build
 *   2. npm run build:web
 *   3. npm run test:e2e
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  // The tests share one server and one account, so they run in order, one at a time.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: 'http://localhost:8081',
    // iPhone-sized viewport: this is a phone app first.
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node e2e/serve.mjs 8081',
    url: 'http://localhost:8081',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
