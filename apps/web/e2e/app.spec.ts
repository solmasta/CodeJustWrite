import { test, expect } from '@playwright/test';
import { signIn, startSession, sendMessage, waitForAgentResponse, openSettings, TEST_SERVER, TEST_TOKEN } from './utils';

test.describe('CodeJustWrite Web App', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(TEST_SERVER);
  });

  test.describe('Sign-in Flow', () => {
    test('shows sign-in screen by default', async ({ page }) => {
      await expect(page.locator('.sign-in-container')).toBeVisible();
      await expect(page.locator('h2')).toContainText('Sign In');
    });

    test('has server URL input', async ({ page }) => {
      await expect(page.locator('#serverUrl')).toBeVisible();
    });

    test('has token input', async ({ page }) => {
      await expect(page.locator('#serverToken')).toBeVisible();
    });

    test('server URL defaults to current origin', async ({ page }) => {
      const value = await page.locator('#serverUrl').inputValue();
      expect(value).toBe(new URL(TEST_SERVER).origin);
    });

    test('shows validation error for empty server URL', async ({ page }) => {
      await page.locator('#serverUrl').clear();
      await page.locator('button:has-text("Continue")').click();
      await expect(page.locator('.error-msg')).toContainText('required');
    });

    test('shows error for invalid server', async ({ page }) => {
      await page.locator('#serverUrl').fill('http://invalid.local');
      await page.locator('button:has-text("Continue")').click();
      await expect(page.locator('.error-msg')).toBeVisible();
    });
  });

  test.describe('Repository Selection', () => {
    test.beforeEach(async ({ page }) => {
      await signIn(page);
    });

    test('shows repo selection screen', async ({ page }) => {
      await expect(page.locator('.repo-select-container')).toBeVisible();
    });

    test('has search input', async ({ page }) => {
      await expect(page.locator('#repoSearch')).toBeVisible();
    });

    test('has browse button', async ({ page }) => {
      await expect(page.locator('button:has-text("Browse my repos")')).toBeVisible();
    });

    test('can filter repos by search', async ({ page }) => {
      await page.locator('button:has-text("Browse my repos")').click();
      await page.waitForSelector('.repo-item', { timeout: 5000 });
      await page.locator('#repoSearch').fill('test');
      const items = page.locator('.repo-item');
      const count = await items.count();
      if (count > 0) {
        const text = await items.first().textContent();
        expect(text?.toLowerCase()).toContain('test');
      }
    });

    test('can select and start session', async ({ page }) => {
      await page.locator('button:has-text("Browse my repos")').click();
      await page.waitForSelector('.repo-item', { timeout: 5000 });
      await page.locator('.repo-item').first().click();
      await page.locator('button:has-text("Start session")').click();
      await page.waitForSelector('.chat-container', { timeout: 10000 });
    });
  });

  test.describe('Chat Interface', () => {
    test.beforeEach(async ({ page }) => {
      await startSession(page);
    });

    test('shows chat container', async ({ page }) => {
      await expect(page.locator('.chat-container')).toBeVisible();
    });

    test('has message input', async ({ page }) => {
      await expect(page.locator('#messageInput')).toBeVisible();
    });

    test('can send message', async ({ page }) => {
      await sendMessage(page, 'Hello');
      await expect(page.locator('.user-message')).toContainText('Hello');
    });

    test('shows thinking indicator', async ({ page }) => {
      await sendMessage(page, 'Hello');
      await expect(page.locator('.thinking')).toBeVisible({ timeout: 3000 });
    });

    test('receives agent response', async ({ page }) => {
      await sendMessage(page, 'Hello');
      await page.waitForSelector('.agent-message', { timeout: 15000 });
      await expect(page.locator('.agent-message')).toBeVisible();
    });

    test('can clear chat', async ({ page }) => {
      await sendMessage(page, 'Hello');
      await page.waitForSelector('.user-message', { timeout: 2000 });
      await page.locator('button:has-text("Clear")').click();
      await expect(page.locator('.user-message')).toHaveCount(0);
    });
  });

  test.describe('Settings', () => {
    test.beforeEach(async ({ page }) => {
      await startSession(page);
      await openSettings(page);
    });

    test('shows settings modal', async ({ page }) => {
      await expect(page.locator('.settings-modal')).toBeVisible();
    });

    test('has provider select', async ({ page }) => {
      await expect(page.locator('#provider')).toBeVisible();
    });

    test('can change provider', async ({ page }) => {
      await page.locator('#provider').selectOption('deepinfra');
      await expect(page.locator('#model')).toHaveValue(/deepinfra/i);
    });

    test('has auto-approve toggle', async ({ page }) => {
      await expect(page.locator('#autoApprove')).toBeVisible();
    });
  });

  test.describe('Keyboard Shortcuts', () => {
    test.beforeEach(async ({ page }) => {
      await startSession(page);
    });

    test('sends on Enter', async ({ page }) => {
      await page.locator('#messageInput').fill('Hello');
      await page.keyboard.press('Enter');
      await expect(page.locator('.user-message')).toContainText('Hello');
    });

    test('clears on Escape', async ({ page }) => {
      await page.locator('#messageInput').fill('Hello');
      await page.keyboard.press('Escape');
      await expect(page.locator('#messageInput')).toHaveValue('');
    });

    test('focuses on Ctrl+K', async ({ page }) => {
      await page.keyboard.press('Control+k');
      await expect(page.locator('#messageInput')).toBeFocused();
    });
  });

  test.describe('Responsive', () => {
    test('mobile viewport', async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 667 });
      await expect(page.locator('.sign-in-container')).toBeVisible();
    });

    test('desktop viewport', async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 720 });
      await expect(page.locator('.sign-in-container')).toBeVisible();
    });
  });

  test.describe('Accessibility', () => {
    test('has heading structure', async ({ page }) => {
      await expect(page.locator('h1')).toBeVisible();
      await expect(page.locator('h2').first()).toBeVisible();
    });

    test('inputs have labels', async ({ page }) => {
      const inputs = page.locator('input:not([type="hidden"])');
      const count = await inputs.count();
      for (let i = 0; i < count; i++) {
        const input = inputs.nth(i);
        const id = await input.getAttribute('id');
        if (id) {
          await expect(page.locator(`label[for="${id}"]`)).toBeAttached();
        }
      }
    });
  });
});