import { test, expect } from '@playwright/test';

test('welcome routes readers to the demo and three onboarding paths', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto('./');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('whole world to explore');
  await expect(page.getByRole('link', { name: 'Explore the demo' })).toHaveAttribute('href', 'https://omdaniel.github.io/bedrock-surface-map/demo/');
  await expect(page.locator('.hero-map img')).toHaveJSProperty('complete', true);
  expect(await page.locator('.hero-map img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(1000);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('welcome.png'), fullPage: true });
  await page.getByRole('link', { name: 'I have a world export' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Install a Snapshot Viewer');
  await page.goto('./');
  await page.getByRole('link', { name: 'I run a Bedrock server' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Download the Live Operator Bundle');
  await page.goto('./');
  await page.getByRole('link', { name: 'I want to contribute' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Contributing');
  expect(errors).toEqual([]);
});

test('local search finds installation content and direct guide reloads work', async ({ page }) => {
  await page.goto('./docs/USER-GUIDE.html');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Use the Map');
  await page.getByRole('button', { name: /Search/ }).first().click();
  await page.locator('#localsearch-input').fill('operator bundle');
  await expect(page.locator('.VPLocalSearchBox .results')).toContainText('Download the Live Operator Bundle');
  await page.keyboard.press('Escape');
  await expect(page.locator('#localsearch-input')).not.toBeVisible();
});
