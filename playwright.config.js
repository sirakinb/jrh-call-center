import { defineConfig } from '@playwright/test';

const PORT = 8099;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 15_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
  },
  webServer: {
    command: 'node src/server.js',
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: false,
    env: {
      PORT: String(PORT),
      TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32),
      TWILIO_AUTH_TOKEN: 'test-auth-token',
      TWILIO_API_KEY_SID: 'SK' + 'b'.repeat(32),
      TWILIO_API_KEY_SECRET: 'test-api-secret',
      TWILIO_TWIML_APP_SID: 'AP' + 'c'.repeat(32),
      PUBLIC_BASE_URL: `http://127.0.0.1:${PORT}`,
      CONSOLE_SECRET: 'e2e-console-secret',
      CONSOLE_USERS: JSON.stringify([
        { id: 'aki', name: 'Aki', password: 'e2e-pass-aki' },
        { id: 'front-desk', name: 'Front Desk', password: 'e2e-pass-desk', openName: true },
      ]),
    },
  },
});
