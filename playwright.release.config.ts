import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  outputDir: 'test-results-release',
  reporter: [['html', { open: 'never', outputFolder:
    'playwright-report-release' }], ['list']],
  testDir: 'tests/e2e',
  testMatch: 'release.spec.ts',
  use: {
    baseURL: 'http://127.0.0.1:1421',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port 1421',
    reuseExistingServer: false,
    timeout: 120_000,
    url: 'http://127.0.0.1:1421',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
