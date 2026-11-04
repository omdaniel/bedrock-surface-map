import { test, expect } from '@playwright/test';

test('documentation index links to user and developer guides', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('./');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Bedrock Surface Map');
  await expect(page.locator('.vp-doc').getByRole('link', { name: 'Try the demo' })).toHaveAttribute('href', 'https://omdaniel.github.io/bedrock-surface-map/demo/');
  await expect(page.locator('.vp-doc img')).toHaveCount(0);
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('welcome.png'), fullPage: true });
  await page.getByRole('link', { name: 'Install the snapshot viewer', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Install a Snapshot Viewer');
  await page.goto('./');
  await page.getByRole('link', { name: 'Download the operator bundle', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Download the Live Operator Bundle');
  await page.goto('./');
  await page.locator('.vp-doc').getByRole('link', { name: 'Contribution guide', exact: true }).click();
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
