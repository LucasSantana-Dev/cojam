import { test, expect } from '@playwright/test';
import { proxyConnectionToken } from './connectionTokenProxy';

// #308: landing name + "Criar sala" lands the user inside a new room under
// that display name, with no second name form.
test('landing: name and create room lands inside the room as that name', async ({ page }) => {
  await proxyConnectionToken(page);
  await page.goto('/');
  await page.getByLabel('Seu nome').fill('Ana');
  await page.getByRole('button', { name: 'Criar sala' }).click();

  await expect(page).toHaveURL(/\/room\/[0-9A-Z]{12}$/);
  // Auto-joined: the room header shows the display name, never the join form.
  await expect(page.getByText('you’re Ana')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Join & Play' })).toHaveCount(0);
});
