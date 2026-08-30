import { test, expect, Page } from '@playwright/test';

const TEST_SERVER = process.env.TEST_SERVER || 'http://localhost:8787';
const TEST_TOKEN = process.env.TEST_TOKEN || 'test-token';

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
      const input = page.locator('#serverUrl');
      await expect(input).toBeVisible();
      await expect(input).toHaveAttribute('placeholder', 'Server URL');
    });

    test('has token input', async ({ page }) => {
      const input = page.locator('#serverToken');
      await expect(input).toBeVisible();
      await expect(input).toHaveAttribute('placeholder', 'Token (optional)');
    });

    test('server URL defaults to current origin', async ({ page }) => {
      const input = page.locator('#serverUrl');
      const value = await input.inputValue();
      expect(value).toBe(new URL(TEST_SERVER).origin);
    });

    test('shows validation error for empty server URL', async ({ page }) => {
      await page.locator('#serverUrl').clear();
      await page.locator('button:has-text("Continue")').click();
      await expect(page.locator('.error-msg')).toContainText('Server URL is required');
    });

    test('shows error for invalid server URL', async ({ page }) => {
      await page.locator('#serverUrl').fill('http://invalid-url-that-does-not-exist.local');
      await page.locator('button:has-text("Continue")').click();
      await expect(page.locator('.error-msg')).toContainText(/connection|network|fetch/i);
    });

    test('shows error for invalid token', async ({ page }) => {
      await page.locator('#serverToken').fill('invalid-token');
      await page.locator('button:has-text("Continue")').click();
      await expect(page.locator('.error-msg')).toContainText(/invalid|unauthorized|401/i);
    });
  });

  test.describe('Repository Selection', () => {
    test.beforeEach(async ({ page }) => {
      await page.locator('#serverUrl').fill(TEST_SERVER);
      await page.locator('#serverToken').fill(TEST_TOKEN);
      await page.locator('button:has-text("Continue")').click();
      await page.waitForSelector('.repo-select-container', { timeout: 5000 });
    });

    test('shows repo selection screen', async ({ page }) => {
      await expect(page.locator('.repo-select-container')).toBeVisible();
      await expect(page.locator('h2')).toContainText('Select Repository');
    });

    test('shows search input', async ({ page }) => {
      const input = page.locator('#repoSearch');
      await expect(input).toBeVisible();
      await expect(input).toHaveAttribute('placeholder', 'Search repositories...');
    });

    test('shows browse button', async ({ page }) => {
      const button = page.locator('button:has-text("Browse my repos")');
      await expect(button).toBeVisible();
    });

    test('shows recent repos section', async ({ page }) => {
      await expect(page.locator('.recent-section')).toBeVisible();
    });

    test('can filter repos by search', async ({ page }) => {
      await page.locator('button:has-text("Browse my repos")').click();
      await page.waitForSelector('.repo-item', { timeout: 5000 });
      
      const searchInput = page.locator('#repoSearch');
      await searchInput.fill('test');
      
      const items = page.locator('.repo-item');
      const count = await items.count();
      if (count > 0) {
        const firstItem = await items.first().textContent();
        expect(firstItem?.toLowerCase()).toContain('test');
      }
    });

    test('can select a repo from list', async ({ page }) => {
      await page.locator('button:has-text("Browse my repos")').click();
      await page.waitForSelector('.repo-item', { timeout: 5000 });
      
      await page.locator('.repo-item').first().click();
      
      await expect(page.locator('#repoUrl')).not.toBeEmpty();
    });

    test('can start session with selected repo', async ({ page }) => {
      await page.locator('button:has-text("Browse my repos")').click();
      await page.waitForSelector('.repo-item', { timeout: 5000 });
      
      await page.locator('.repo-item').first().click();
      await page.locator('button:has-text("Start session")').click();
      
      await page.waitForSelector('.chat-container', { timeout: 10000 });
    });
  });

  test.describe('Chat Interface', () => {
    test.beforeEach(async ({ page }) => {
      await page.locator('#serverUrl').fill(TEST_SERVER);
      await page.locator('#serverToken').fill(TEST_TOKEN);
      await page.locator('button:has-text("Continue")').click();
      await page.waitForSelector('.repo-select-container', { timeout: 5000 });
      
      await page.locator('#repoUrl').fill('https://github.com/test/repo');
      await page.locator('#branch').fill('main');
      await page.locator('button:has-text("Start session")').click();
      await page.waitForSelector('.chat-container', { timeout: 10000 });
    });

    test('shows chat interface', async ({ page }) => {
      await expect(page.locator('.chat-container')).toBeVisible();
    });

    test('has message input', async ({ page }) => {
      const input = page.locator('#messageInput');
      await expect(input).toBeVisible();
    });

    test('has send button', async ({ page }) => {
      const button = page.locator('button:has-text("Send")');
      await expect(button).toBeVisible();
    });

    test('can type and send message', async ({ page }) => {
      const input = page.locator('#messageInput');
      await input.fill('Hello');
      await page.locator('button:has-text("Send")').click();
      
      await expect(page.locator('.user-message')).toContainText('Hello');
    });

    test('shows thinking indicator', async ({ page }) => {
      const input = page.locator('#messageInput');
      await input.fill('Tell me about the repo');
      await page.locator('button:has-text("Send")').click();
      
      await expect(page.locator('.thinking')).toBeVisible({ timeout: 2000 });
    });

    test('shows agent response', async ({ page }) => {
      const input = page.locator('#messageInput');
      await input.fill('Hello');
      await page.locator('button:has-text("Send")').click();
      
      await page.waitForSelector('.agent-message', { timeout: 15000 });
      await expect(page.locator('.agent-message')).toBeVisible();
    });

    test('has clear button', async ({ page }) => {
      const button = page.locator('button:has-text("Clear")');
      await expect(button).toBeVisible();
    });

    test('can clear chat', async ({ page }) => {
      const input = page.locator('#messageInput');
      await input.fill('Hello');
      await page.locator('button:has-text("Send")').click();
      
      await page.waitForSelector('.user-message', { timeout: 2000 });
      await page.locator('button:has-text("Clear")').click();
      
      await expect(page.locator('.user-message')).toHaveCount(0);
    });

    test('has settings button', async ({ page }) => {
      const button = page.locator('button:has-text("Settings")');
      await expect(button).toBeVisible();
    });

    test('can open and close settings', async ({ page }) => {
      await page.locator('button:has-text("Settings")').click();
      await expect(page.locator('.settings-modal')).toBeVisible();
      
      await page.locator('.settings-modal .close').click();
      await expect(page.locator('.settings-modal')).not.toBeVisible();
    });
  });

  test.describe('Settings Modal', () => {
    test.beforeEach(async ({ page }) => {
      await page.locator('#serverUrl').fill(TEST_SERVER);
      await page.locator('#serverToken').fill(TEST_TOKEN);
      await page.locator('button:has-text("Continue")').click();
      await page.waitForSelector('.repo-select-container', { timeout: 5000 });
      
      await page.locator('#repoUrl').fill('https://github.com/test/repo');
      await page.locator('#branch').fill('main');
      await page.locator('button:has-text("Start session")').click();
      await page.waitForSelector('.chat-container', { timeout: 10000 });
      
      await page.locator('button:has-text("Settings")').click();
      await page.waitForSelector('.settings-modal', { timeout: 2000 });
    });

    test('shows provider select', async ({ page }) => {
      const select = page.locator('#provider');
      await expect(select).toBeVisible();
    });

    test('shows model input', async ({ page }) => {
      const input = page.locator('#model');
      await expect(input).toBeVisible();
    });

    test('shows api key input', async ({ page }) => {
      const input = page.locator('#apiKey');
      await expect(input).toBeVisible();
    });

    test('shows auto-approve toggle', async ({ page }) => {
      const toggle = page.locator('#autoApprove');
      await expect(toggle).toBeVisible();
    });

    test('can change provider', async ({ page }) => {
      const select = page.locator('#provider');
      await select.selectOption('deepinfra');
      
      await expect(page.locator('#model')).toHaveValue(/deepinfra/i);
    });

    test('can toggle auto-approve', async ({ page }) => {
      const toggle = page.locator('#autoApprove');
      const isChecked = await toggle.isChecked();
      
      await toggle.click();
      
      await expect(page.locator('#autoApprove')).not.toBeChecked();
    });
  });

  test.describe('Keyboard Shortcuts', () => {
    test.beforeEach(async ({ page }) => {
      await page.locator('#serverUrl').fill(TEST_SERVER);
      await page.locator('#serverToken').fill(TEST_TOKEN);
      await page.locator('button:has-text("Continue")').click();
      await page.waitForSelector('.repo-select-container', { timeout: 5000 });
      
      await page.locator('#repoUrl').fill('https://github.com/test/repo');
      await page.locator('#branch').fill('main');
      await page.locator('button:has-text("Start session")').click();
      await page.waitForSelector('.chat-container', { timeout: 10000 });
    });

    test('sends message on Enter', async ({ page }) => {
      const input = page.locator('#messageInput');
      await input.fill('Hello');
      await input.press('Enter');
      
      await expect(page.locator('.user-message')).toContainText('Hello');
    });

    test('clears on Escape', async ({ page }) => {
      const input = page.locator('#messageInput');
      await input.fill('Hello');
      await input.press('Escape');
      
      await expect(input).toHaveValue('');
    });

    test('focuses input on Ctrl+K', async ({ page }) => {
      await page.keyboard.press('Control+k');
      
      await expect(page.locator('#messageInput')).toBeFocused();
    });
  });

  test.describe('Responsive Design', () => {
    test('works on mobile', async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 667 });
      
      await expect(page.locator('.sign-in-container')).toBeVisible();
    });

    test('works on tablet', async ({ page }) => {
      await page.setViewportSize({ width: 768, height: 1024 });
      
      await expect(page.locator('.sign-in-container')).toBeVisible();
    });

    test('works on desktop', async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 720 });
      
      await expect(page.locator('.sign-in-container')).toBeVisible();
    });
  });

  test.describe('Accessibility', () => {
    test('has proper heading structure', async ({ page }) => {
      const h1 = page.locator('h1');
      const h2 = page.locator('h2').first();
      
      await expect(h1).toBeVisible();
      await expect(h2).toBeVisible();
    });

    test('inputs have labels', async ({ page }) => {
      const inputs = page.locator('input:not([type="hidden"])');
      const count = await inputs.count();
      
      for (let i = 0; i < count; i++) {
        const input = inputs.nth(i);
        const id = await input.getAttribute('id');
        if (id) {
          const label = page.locator(`label[for="${id}"]`);
          await expect(label).toBeAttached();
        }
      }
    });

    test('buttons are keyboard accessible', async ({ page }) => {
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => document.activeElement?.tagName);
      
      expect(focused?.toLowerCase()).toBe('button');
    });
  });
});

test.describe('Visual Regression', () => {
  test('sign-in screen matches design', async ({ page }) => {
    await page.goto(TEST_SERVER);
    
    await expect(page.locator('.sign-in-container')).toHaveScreenshot('sign-in.png', {
      animations: 'disabled'
    });
  });

  test('chat interface matches design', async ({ page }) => {
    await page.goto(TEST_SERVER);
    await page.locator('#serverUrl').fill(TEST_SERVER);
    await page.locator('#serverToken').fill(TEST_TOKEN);
    await page.locator('button:has-text("Continue")').click();
    await page.waitForSelector('.repo-select-container', { timeout: 5000 });
    await page.locator('#repoUrl').fill('https://github.com/test/repo');
    await page.locator('#branch').fill('main');
    await page.locator('button:has-text("Start session")').click();
    await page.waitForSelector('.chat-container', { timeout: 10000 });
    
    await expect(page.locator('.chat-container')).toHaveScreenshot('chat.png', {
      animations: 'disabled'
    });
  });
});