import { defineConfig, devices } from '@playwright/test';

// Per-run port (PW_PORT) so parallel runs and other agents' dev servers on 1420 don't collide.
const port = Number(process.env.PW_PORT ?? 1420);
const url = `http://127.0.0.1:${port}`;

export default defineConfig({
  fullyParallel: false,
  outputDir: 'test-results',
  reporter: [['html', { open: 'never' }], ['list']],
  testDir: 'tests/e2e',
  testIgnore: 'release.spec.ts',
  use: {
    baseURL: url,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${port} --strictPort`,
    reuseExistingServer: false,
    timeout: 120_000,
    url,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
