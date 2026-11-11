import { expect, test, type Page } from '@playwright/test';

import {
  API,
  chooseFiles,
  EMAIL,
  login,
  openTab,
  PASSWORD,
  shot,
  waitForThumbnails,
  wipeServer,
} from './helpers';

const MEDIA = ['sunset.jpg', 'forest.jpg', 'ocean.jpg', 'city.jpg', 'portrait.jpg', 'iphone.heic', 'clip.mp4'];

test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
  await wipeServer();
  page = await browser.newPage();
});

test.afterAll(async () => {
  await page.close();
});

test('login rejects a wrong password, then accepts the right one', async () => {
  await page.goto('/');
  await expect(page.getByTestId('login-submit')).toBeVisible();
  await page.screenshot({ path: shot('01-login') });

  await page.getByTestId('login-server').fill(API);
  await page.getByTestId('login-email').fill(EMAIL);
  await page.getByTestId('login-password').fill('definitely-wrong');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-error')).toContainText('Incorrect email or password');

  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByRole('heading', { name: 'Photos' })).toBeVisible();
  await expect(page.getByText('No photos yet')).toBeVisible();
});

test('login explains an unreachable server', async ({ browser }) => {
  const other = await browser.newPage();
  await other.goto('/');
  await other.getByTestId('login-server').fill('http://localhost:9');
  await other.getByTestId('login-email').fill(EMAIL);
  await other.getByTestId('login-password').fill(PASSWORD);
  await other.getByTestId('login-submit').click();
  await expect(other.getByTestId('login-error')).toContainText("Can't reach a PiVault server");
  await other.close();
});

test('uploading photos, a HEIC and a video fills the timeline', async () => {
  await chooseFiles(page, () => page.getByTestId('empty-upload').click(), MEDIA);
  await expect(page.getByTestId('toast')).toContainText('7 uploaded', { timeout: 30_000 });

  // The worker makes thumbnails in the background; the grid picks them up by itself.
  await waitForThumbnails(page, 7);

  // Grouped by the month each photo was taken (read from EXIF), newest first.
  const headers = await page.getByTestId('photo-grid').getByRole('heading').allInnerTexts();
  // (The HEIC fixture has no capture date, so it files under the month it was uploaded.)
  const dated = ['October 2026', 'September 2026', 'August 2026', 'December 2025'];
  expect(headers.filter((title) => dated.includes(title))).toEqual(dated);
  expect(headers).toHaveLength(5);
  await expect(page.getByLabel('Video clip.mp4', { exact: true })).toContainText('0:03');
  await page.screenshot({ path: shot('02-photos') });
});

test('uploading the same photo again is recognised as a duplicate', async () => {
  await chooseFiles(page, () => page.getByTestId('photos-upload').click(), ['sunset.jpg']);
  await expect(page.getByTestId('toast')).toContainText('1 already in your vault');
  await expect(page.locator('[data-testid^="thumb-"]')).toHaveCount(7);
});

test('the grid size can be changed', async () => {
  const cell = page.locator('[data-testid^="thumb-"]').first();
  const before = (await cell.boundingBox())!.width;
  await page.getByTestId('grid-columns').click();
  await expect.poll(async () => (await cell.boundingBox())!.width).toBeLessThan(before);
  // Cycle back round to the default four columns.
  for (let i = 0; i < 3; i += 1) await page.getByTestId('grid-columns').click();
  await expect.poll(async () => Math.round((await cell.boundingBox())!.width)).toBe(Math.round(before));
});

test('the viewer shows a photo with its details and steps between items', async () => {
  await page.getByLabel('Photo sunset.jpg', { exact: true }).click();
  await expect(page.getByTestId('viewer')).toBeVisible();
  await expect(page.getByTestId('viewer-title')).toContainText('Oct 12, 2026');

  // The full-size preview really loads.
  await expect
    .poll(async () =>
      page.evaluate(() =>
        [...document.querySelectorAll('[data-testid^="viewer-image-"] img')].some(
          (img) => (img as HTMLImageElement).naturalWidth >= 1000,
        ),
      ),
    )
    .toBe(true);

  await page.getByTestId('viewer-info').click();
  await expect(page.getByTestId('viewer-details')).toContainText('sunset.jpg');
  await expect(page.getByTestId('viewer-details')).toContainText('1600 × 1200');
  await page.screenshot({ path: shot('03-viewer') });
  await page.getByTestId('viewer-info').click();

  const first = await page.getByTestId('viewer-title').innerText();
  await page.getByTestId('viewer-next').click();
  await expect(page.getByTestId('viewer-title')).not.toHaveText(first);
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('viewer-title')).toHaveText(first);

  await page.getByTestId('viewer-close').click();
  await expect(page.getByTestId('viewer')).toBeHidden();
});

test('a video plays and can be seeked', async () => {
  await page.getByLabel('Video clip.mp4', { exact: true }).click();
  const video = page.locator('video');
  await expect(video).toBeVisible();
  // Metadata loaded means the browser fetched the file with a Range request.
  await expect.poll(async () => video.evaluate((v: HTMLVideoElement) => v.duration)).toBeGreaterThan(2.5);
  await video.evaluate(async (v: HTMLVideoElement) => {
    v.muted = true;
    v.currentTime = 2;
    await v.play().catch(() => undefined);
  });
  await expect.poll(async () => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(1.9);
  await page.getByTestId('viewer-close').click();
});

test('a photo can be downloaded with its original bytes', async () => {
  await page.getByLabel('Photo ocean.jpg', { exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByTestId('viewer-save').click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('ocean.jpg');
  const fs = await import('node:fs');
  const { fixture } = await import('./helpers');
  expect(fs.readFileSync(await file.path())).toEqual(fs.readFileSync(fixture('ocean.jpg')));
  await page.getByTestId('viewer-close').click();
});

test('deleting moves a photo to the trash, and it can be restored', async () => {
  await page.getByLabel('Photo city.jpg', { exact: true }).click();
  await page.getByTestId('viewer-delete').click();
  await expect(page.getByTestId('dialog')).toContainText('Move this photo to the trash?');
  await page.getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('viewer-title')).not.toContainText('Aug 2, 2026');
  await page.getByTestId('viewer-close').click();
  await expect(page.locator('[data-testid^="thumb-"]')).toHaveCount(6);

  await openTab(page, 'Settings');
  await expect(page.getByTestId('open-trash')).toContainText('1 item');
  await page.getByTestId('open-trash').click();
  await expect(page.getByRole('heading', { name: 'Trash' })).toBeVisible();
  await page.getByLabel('Photo city.jpg', { exact: true }).click();
  await page.getByTestId('sheet-restore').click();
  await expect(page.getByText('Trash is empty')).toBeVisible();
  await page.getByTestId('trash-close').click();

  await openTab(page, 'Photos');
  await expect(page.locator('[data-testid^="thumb-"]')).toHaveCount(7);
});

test('several photos can be selected and trashed together', async () => {
  // Long-press starts a selection; further taps add to it.
  await page.getByLabel('Photo portrait.jpg', { exact: true }).click({ delay: 700 });
  await page.getByLabel('Photo forest.jpg', { exact: true }).click();
  await expect(page.getByTestId('selection-count')).toHaveText('2 selected');
  await page.getByTestId('selection-delete').click();
  await page.getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('toast')).toContainText('2 moved to the trash');
  await expect(page.locator('[data-testid^="thumb-"]')).toHaveCount(5);
});

test('files: folders, upload, rename, move and delete', async () => {
  await openTab(page, 'Files');
  await expect(page.getByText('No files yet')).toBeVisible();

  await page.getByTestId('files-new-folder').click();
  await page.getByTestId('dialog-input').fill('Documents');
  await page.getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('folder-Documents')).toBeVisible();

  // A second folder with the same name is refused by the server.
  await page.getByTestId('files-new-folder').click();
  await page.getByTestId('dialog-input').fill('documents');
  await page.getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('toast')).toContainText('already exists');

  await page.getByTestId('folder-Documents').click();
  await expect(page.getByText('This folder is empty')).toBeVisible();
  await chooseFiles(page, () => page.getByTestId('files-upload').click(), ['notes.txt']);
  await expect(page.getByTestId('file-notes.txt')).toBeVisible();
  await expect(page.getByTestId('file-notes.txt')).toContainText('900 B');

  await page.getByTestId('file-notes.txt-menu').click();
  await page.getByTestId('sheet-rename').click();
  await page.getByTestId('dialog-input').fill('meeting-notes.txt');
  await page.getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('file-meeting-notes.txt')).toBeVisible();
  await page.screenshot({ path: shot('04-files') });

  await page.getByTestId('file-meeting-notes.txt-menu').click();
  await page.getByTestId('sheet-move').click();
  await page.getByTestId('sheet-root').click();
  await expect(page.getByText('This folder is empty')).toBeVisible();

  await page.getByTestId('crumb-root').click();
  await expect(page.getByTestId('file-meeting-notes.txt')).toBeVisible();

  await page.getByTestId('folder-Documents-menu').click();
  await page.getByTestId('sheet-delete').click();
  await page.getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('folder-Documents')).toBeHidden();

  // Plain files never show up in the photo timeline.
  await openTab(page, 'Photos');
  await expect(page.locator('[data-testid^="thumb-"]')).toHaveCount(5);
});

test('backup tab explains itself in a browser', async () => {
  await openTab(page, 'Backup');
  await expect(page.getByTestId('backup-headline')).toHaveText('Backup runs on your iPhone');
  await expect(page.getByTestId('backup-web-upload')).toBeVisible();
});

test('settings shows storage and counts', async () => {
  await openTab(page, 'Settings');
  await expect(page.getByTestId('count-photos')).toHaveText('4');
  await expect(page.getByTestId('count-videos')).toHaveText('1');
  await expect(page.getByTestId('count-files')).toHaveText('1');
  await expect(page.getByTestId('storage-free')).toContainText('free of');
  await expect(page.getByText(/Healthy \(v\d/)).toBeVisible();
  await expect(page.getByText(EMAIL)).toBeVisible();
  await expect(page.getByTestId('toast')).toBeHidden();
  await page.screenshot({ path: shot('05-settings') });
});

test('the session survives a reload and an expired access token', async () => {
  // Break the access token and mark it expired; the refresh token must recover the session.
  await page.evaluate(() => {
    const session = JSON.parse(localStorage.getItem('pivault.session')!);
    session.accessToken = 'expired-token';
    session.accessExpiresAt = Date.now() - 60_000;
    localStorage.setItem('pivault.session', JSON.stringify(session));
  });
  await page.reload();
  // Still signed in, on the same screen, with data loading again.
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByTestId('count-photos')).toHaveText('4');
  await openTab(page, 'Photos');
  await waitForThumbnails(page, 5);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('pivault.session')!));
  expect(stored.accessToken).not.toBe('expired-token');
});

test('emptying the trash deletes for good', async () => {
  await openTab(page, 'Settings');
  await page.getByTestId('open-trash').click();
  // Scoped to the trash list: the Photos tab stays mounted behind this screen.
  await expect(page.getByTestId('trash-list').locator('[data-testid^="thumb-"]')).toHaveCount(2);
  await page.getByTestId('trash-empty').click();
  await page.getByTestId('dialog-confirm').click();
  await expect(page.getByText('Trash is empty')).toBeVisible();
  await page.getByTestId('trash-close').click();
});

test('logging out returns to the login screen and forgets the session', async () => {
  await openTab(page, 'Settings');
  await page.getByTestId('logout').click();
  await page.getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('login-submit')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('pivault.session'))).toBeNull();
  // The server address is remembered for next time.
  await expect(page.getByTestId('login-server')).toHaveValue(API);

  // Signed-out visitors cannot reach app screens by URL.
  await page.goto('/settings');
  await expect(page.getByTestId('login-submit')).toBeVisible();
});

test('desktop layout uses the wider screen', async ({ browser }) => {
  const wide = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await login(wide);
  await waitForThumbnails(wide, 5);
  const cell = (await wide.locator('[data-testid^="thumb-"]').first().boundingBox())!;
  expect(cell.width).toBeLessThan(200); // more columns than on a phone
  await wide.close();
});
