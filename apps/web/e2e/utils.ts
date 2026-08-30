import type { Page } from '@playwright/test';

export const TEST_SERVER = process.env.TEST_SERVER || 'http://localhost:8787';
export const TEST_TOKEN = process.env.TEST_TOKEN || 'test-token';

export async function signIn(page: Page): Promise<void> {
  await page.goto(TEST_SERVER);
  await page.locator('#serverUrl').fill(TEST_SERVER);
  await page.locator('#serverToken').fill(TEST_TOKEN);
  await page.locator('button:has-text("Continue")').click();
  await page.waitForSelector('.repo-select-container', { timeout: 5000 });
}

export async function startSession(page: Page, repoUrl?: string, branch?: string): Promise<void> {
  await signIn(page);
  await page.locator('#repoUrl').fill(repoUrl || 'https://github.com/test/repo');
  await page.locator('#branch').fill(branch || 'main');
  await page.locator('button:has-text("Start session")').click();
  await page.waitForSelector('.chat-container', { timeout: 10000 });
}

export async function sendMessage(page: Page, message: string): Promise<void> {
  await page.locator('#messageInput').fill(message);
  await page.locator('button:has-text("Send")').click();
}

export async function waitForAgentResponse(page: Page): Promise<void> {
  await page.waitForSelector('.agent-message', { timeout: 15000 });
}

export async function openSettings(page: Page): Promise<void> {
  await page.locator('button:has-text("Settings")').click();
  await page.waitForSelector('.settings-modal', { timeout: 2000 });
}