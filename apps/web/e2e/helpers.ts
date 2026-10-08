import type { Page } from '@playwright/test';

// Opens the inline add area at the top of the queue ("+ Adicionar música") and
// the "Mais opções" / "Adicionar manualmente" disclosures inside it. On phones
// the queue lives behind the Fila tab, so that comes first.
export async function openAdd(page: Page) {
  const fila = page.getByRole('tab', { name: 'Fila', exact: true });
  if (await fila.isVisible()) await fila.click();
  const toggle = page.getByRole('button', { name: /Adicionar música/ });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await page.getByLabel('Buscar uma música').waitFor();
  await page.evaluate(() => {
    document.querySelectorAll('#r4-add-inline details').forEach((d) => ((d as HTMLDetailsElement).open = true));
  });
}

// The avatar menu (top right): opens it when closed.
export async function openAvatarMenu(page: Page) {
  const trigger = page.getByRole('button', { name: /^Menu de/ });
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
}
