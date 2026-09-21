import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_SDK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-twilio-sdk.js');

test.beforeEach(async ({ page }) => {
  await page.route('**/vendor/twilio.min.js', (route) =>
    route.fulfill({ path: FAKE_SDK, contentType: 'application/javascript' }));
  // The app falls back to unpkg if the vendor file defines nothing; the fake
  // always defines Twilio, so this is just a belt-and-braces network guard.
  await page.route('**://unpkg.com/**', (route) => route.abort());
  await page.route('**://fonts.googleapis.com/**', (route) => route.abort());
  await page.route('**://fonts.gstatic.com/**', (route) => route.abort());
});

async function login(page, { name = 'Aki', password = 'e2e-pass-aki' } = {}) {
  await page.goto('/');
  await page.fill('#agentName', name);
  await page.fill('#consolePw', password);
  await page.click('#loginBtn');
  await expect(page.locator('#consoleCard')).toBeVisible();
}

function ringConsole(page, from = '+15551234567') {
  return page.evaluate((f) => {
    const call = new window.__FakeCall({ From: f });
    window.__incoming = call;
    window.__device.emit('incoming', call);
  }, from);
}

test('login page loads the roster without leaking passwords to the browser', async ({ page }) => {
  const cfgPromise = page.waitForResponse('**/api/auth-config');
  await page.goto('/');
  await expect(page.locator('#loginCard')).toBeVisible();
  await expect(page.locator('#consolePw')).toBeVisible();
  const cfg = await (await cfgPromise).json();
  expect(cfg.authRequired).toBe(true);
  expect(cfg.users.map((u) => u.name)).toEqual(['Aki', 'Front Desk']);
  for (const u of cfg.users) expect(u).not.toHaveProperty('password');
});

test('wrong password is rejected and the console stays locked', async ({ page }) => {
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); return d.dismiss(); });
  await page.goto('/');
  await page.fill('#agentName', 'Aki');
  await page.fill('#consolePw', 'not-the-password');
  await page.click('#loginBtn');
  await expect.poll(() => dialogs).toContain('Wrong name or password');
  await expect(page.locator('#consoleCard')).toBeHidden();
});

test('valid login goes online: device registered, presence shown, roster updates', async ({ page }) => {
  await login(page);
  await expect(page.locator('#whoami')).toHaveText('Aki');
  await expect(page.locator('#deviceState')).toHaveText(/Online/);
  await expect(page.locator('#statusText')).toHaveText('Online - taking calls');
  // The 3s status poll should list this agent in the team sidebar.
  await expect(page.locator('#agentList')).toContainText('Aki');
});

test('incoming call: overlay pops, Answer accepts and starts the timer, Hang up resets', async ({ page }) => {
  await login(page);
  await ringConsole(page);
  await expect(page.locator('#incoming')).toBeVisible();
  await expect(page.locator('#idleState')).toBeHidden();

  await page.click('#answerBtn');
  expect(await page.evaluate(() => window.__incoming.accepted)).toBe(true);
  await expect(page.locator('#oncall')).toBeVisible();
  await expect(page.locator('#callTimer')).toHaveText(/00:0[1-9]/, { timeout: 5000 });

  await page.click('#hangupBtn');
  await expect(page.locator('#oncall')).toBeHidden();
  await expect(page.locator('#idleState')).toBeVisible();
  await expect(page.locator('#callTimer')).toHaveText('00:00');
});

test('incoming call: Decline rejects and returns to idle', async ({ page }) => {
  await login(page);
  await ringConsole(page);
  await page.click('#declineBtn');
  expect(await page.evaluate(() => window.__incoming.rejected)).toBe(true);
  await expect(page.locator('#incoming')).toBeHidden();
  await expect(page.locator('#idleState')).toBeVisible();
});

test('caller hanging up before answer clears the ringing overlay', async ({ page }) => {
  await login(page);
  await ringConsole(page);
  await expect(page.locator('#incoming')).toBeVisible();
  await page.evaluate(() => window.__incoming.emit('cancel'));
  await expect(page.locator('#incoming')).toBeHidden();
  await expect(page.locator('#idleState')).toBeVisible();
});

test('mute toggles the microphone on a live call', async ({ page }) => {
  await login(page);
  await ringConsole(page);
  await page.click('#answerBtn');
  await page.click('#muteBtn');
  await expect(page.locator('#muteBtn')).toHaveText('Unmute');
  expect(await page.evaluate(() => window.__incoming.mutedState)).toBe(true);
  await page.click('#muteBtn');
  await expect(page.locator('#muteBtn')).toHaveText('Mute');
  expect(await page.evaluate(() => window.__incoming.mutedState)).toBe(false);
});

test('Answer next in queue dials out with the server-bound identity', async ({ page }) => {
  await login(page);
  await page.click('#answerNextBtn');
  await expect(page.locator('#oncall')).toBeVisible();
  const params = await page.evaluate(() => window.__device.lastConnect);
  expect(params.params.identity).toBe('aki');
  await page.click('#hangupBtn');
  await expect(page.locator('#idleState')).toBeVisible();
});

test('rename in settings updates the display name everywhere', async ({ page }) => {
  await login(page, { name: 'Front Desk', password: 'e2e-pass-desk' });
  await page.click('#settingsBtn');
  await expect(page.locator('#settingsOverlay')).toBeVisible();
  await page.fill('#settingsName', 'Darryl');
  await page.click('#settingsSave');
  await expect(page.locator('#settingsOverlay')).toBeHidden();
  await expect(page.locator('#whoami')).toHaveText('Darryl');
  await expect(page.locator('#avatar')).toHaveText('D');
});
