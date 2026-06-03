import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 25_000 },
  fullyParallel: false,
  retries: 1,
  use: {
    baseURL: 'http://localhost:5199',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npx vite --port 5199 --strictPort',
    url: 'http://localhost:5199',
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'desktop-chrome',
      use: { viewport: { width: 1280, height: 800 } },
    },
  ],
})
