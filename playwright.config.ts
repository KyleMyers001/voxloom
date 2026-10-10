import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  fullyParallel: false,
  outputDir: 'test-results',
  reporter: [['html', { open: 'never' }], ['list']],
  testDir: 'tests/e2e',
  testIgnore: 'release.spec.ts',
  use: {
    baseURL: 'http://127.0.0.1:1420',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1',
    reuseExistingServer: false,
    timeout: 120_000,
    url: 'http://127.0.0.1:1420',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
