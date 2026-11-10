import { defineConfig } from '@playwright/test';
import process from 'node:process';
const port = 14428;
export default defineConfig({
  testDir: './tests/e2e', testMatch: 'guided-onboarding.spec.ts',
  outputDir: process.env.GUIDED_RESULTS_DIR ?? 'test-results-guided', reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${port}`, channel: 'chrome', trace: 'retain-on-failure' },
  webServer: { command: `npx vite --host 127.0.0.1 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false },
});
