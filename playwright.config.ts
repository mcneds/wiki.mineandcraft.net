import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:4321', channel: process.env.PLAYWRIGHT_CHANNEL || (process.env.CI ? undefined : 'msedge'), trace: 'retain-on-failure' },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1080 } } }, { name: 'mobile', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } }],
  webServer: { command: 'npm run preview:worker', url: 'http://127.0.0.1:4321', reuseExistingServer: !process.env.CI, timeout: 120000 },
});
