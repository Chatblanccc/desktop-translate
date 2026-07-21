import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  workers: 1,
  retries: 0,
  // Startup, second-instance, product exit, Playwright close, and profile-lock
  // cleanup each have independent fail-closed budgets in the spec. This outer
  // budget only prevents their sum across multi-restart scenarios from masking
  // the specific failing stage.
  timeout: 180_000,
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  }
});
