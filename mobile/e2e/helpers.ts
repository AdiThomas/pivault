import { expect, type Page } from '@playwright/test';
import path from 'node:path';

export const API = process.env.PIVAULT_API ?? 'http://localhost:8000';
export const EMAIL = process.env.PIVAULT_EMAIL ?? 'admin@pivault.dev';
export const PASSWORD = process.env.PIVAULT_PASSWORD ?? 'pivault-dev-pass';

export const fixture = (name: string) => path.join(__dirname, 'fixtures', name);
export const shot = (name: string) =>
  path.join(__dirname, '..', '..', 'docs', 'screenshots', `${name}.png`);

async function token(): Promise<string> {
  const resp = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!resp.ok) throw new Error(`API login failed: ${resp.status}. Is the dev stack running?`);
  return (await resp.json()).access_token;
}

/** Delete every asset (including the trash) and folder, so each run starts empty. */
export async function wipeServer(): Promise<void> {
  const auth = { Authorization: `Bearer ${await token()}` };
  for (const query of ['kind=photo,video,file', 'trashed=true']) {
    for (;;) {
      const page = await (await fetch(`${API}/api/assets?limit=500&${query}`, { headers: auth })).json();
      if (!page.items.length) break;
      for (const asset of page.items) {
        await fetch(`${API}/api/assets/${asset.id}?permanent=true`, { method: 'DELETE', headers: auth });
      }
    }
  }
  const folders = await (await fetch(`${API}/api/folders?parent_id=root`, { headers: auth })).json();
  for (const folder of folders) {
    await fetch(`${API}/api/folders/${folder.id}?recursive=true`, { method: 'DELETE', headers: auth });
  }
  // Deleting folders trashes their files; clear those too.
  for (;;) {
    const page = await (await fetch(`${API}/api/assets?limit=500&trashed=true`, { headers: auth })).json();
    if (!page.items.length) break;
    for (const asset of page.items) {
      await fetch(`${API}/api/assets/${asset.id}?permanent=true`, { method: 'DELETE', headers: auth });
    }
  }
}

export async function login(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('login-submit')).toBeVisible();
  await page.getByTestId('login-server').fill(API);
  await page.getByTestId('login-email').fill(EMAIL);
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByRole('heading', { name: 'Photos' })).toBeVisible();
}

/** Click something that opens the browser file picker, and choose these files. */
export async function chooseFiles(page: Page, trigger: () => Promise<void>, names: string[]) {
  const chooser = page.waitForEvent('filechooser');
  await trigger();
  await (await chooser).setFiles(names.map(fixture));
}

export async function openTab(page: Page, name: 'Photos' | 'Files' | 'Backup' | 'Settings') {
  await page.getByRole('tab', { name }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
}

/** Wait until every thumbnail in view has actually decoded an image. */
export async function waitForThumbnails(page: Page, count: number) {
  const thumbs = page.locator('[data-testid^="thumb-"]');
  await expect(thumbs).toHaveCount(count);
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const cells = [...document.querySelectorAll('[data-testid^="thumb-"]')];
          return cells.filter((cell) => {
            const img = cell.querySelector('img');
            return img && img.complete && img.naturalWidth > 0;
          }).length;
        }),
      { timeout: 30_000 },
    )
    .toBe(count);
}
