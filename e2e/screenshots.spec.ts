import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/*
 * Visual QA set: the four tabs in light and dark plus the tracker editor, at iPhone 14 size, with a
 * month of seeded history so streak chips, heatmaps and bars are populated. PNGs land in
 * e2e/screenshots (git-ignored) or $SCREENSHOT_DIR. This spec only asserts that the pages render;
 * looking at the pictures is the point.
 */

const STORAGE_KEY = 'momentum-v1';
const DIR = process.env.SCREENSHOT_DIR ?? path.join(process.cwd(), 'e2e', 'screenshots');

const pad = (n: number): string => String(n).padStart(2, '0');
const toKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const shift = (d: Date, n: number): Date => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const NOW = new Date();
const daysAgo = (n: number): string => toKey(shift(NOW, -n));
const weekdayOf = (d: Date): number => (d.getDay() + 6) % 7; // Mon = 0 … Sun = 6

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [0, 1, 2, 3, 4];
const MWF = [0, 2, 4];

/** Four active trackers with a few weeks of history and one archived tracker. */
function seed(): string {
  const habits = [
    { id: 'gym', name: 'Gym', emoji: '💪', color: 'terracotta', days: MWF, createdAt: daysAgo(27), order: 0 },
    { id: 'study', name: 'Study 2 hours', emoji: '📚', color: 'slate', note: '2 hours', days: EVERY_DAY, createdAt: daysAgo(27), order: 1 },
    { id: 'wake', name: 'Wake up by 8 AM', emoji: '🌅', color: 'ochre', note: 'by 8 AM', days: WEEKDAYS, createdAt: daysAgo(12), order: 2 },
    { id: 'meditate', name: 'Meditate', emoji: '🧘', color: 'plum', note: '10 minutes', days: EVERY_DAY, createdAt: daysAgo(20), order: 3 },
    { id: 'walk', name: 'Walk the dog', emoji: '🐶', color: 'sage', days: EVERY_DAY, createdAt: daysAgo(40), archivedAt: daysAgo(5), order: 4 },
  ];
  const completions: Record<string, Record<string, true>> = {};
  const mark = (id: string, key: string): void => {
    (completions[id] ??= {})[key] = true;
  };
  for (let n = 27; n >= 1; n -= 1) {
    const d = shift(NOW, -n);
    const wd = weekdayOf(d);
    const key = toKey(d);
    if (MWF.includes(wd) && n !== 10) mark('gym', key);
    if (n !== 12) mark('study', key);
    if (n <= 12 && wd <= 4 && n !== 3) mark('wake', key);
    if (n <= 20 && n % 6 !== 0) mark('meditate', key);
  }
  for (let n = 40; n >= 6; n -= 1) mark('walk', daysAgo(n));
  if (MWF.includes(weekdayOf(NOW))) mark('gym', toKey(NOW)); // one thing already done today
  else mark('meditate', toKey(NOW));
  return JSON.stringify({
    state: { habits, completions, settings: { theme: 'system', installHintDismissed: false } },
    version: 1,
  });
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    return true;
  });
  await page.waitForTimeout(700);
}

async function shot(page: Page, name: string): Promise<void> {
  await settle(page);
  await page.screenshot({ path: path.join(DIR, `${name}.png`), animations: 'disabled', caret: 'hide' });
}

async function scrollMain(page: Page, to: 'top' | 'bottom'): Promise<void> {
  await page
    .locator('.app__main')
    .evaluate((el, where) => el.scrollTo({ top: where === 'bottom' ? el.scrollHeight : 0 }), to);
}

async function openTab(page: Page, label: string): Promise<void> {
  const tab = page.locator('.tabbar').getByRole('button', { name: label, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-current', 'page');
}

test('captures the visual QA set in light and dark', async ({ page }) => {
  test.slow();
  mkdirSync(DIR, { recursive: true });
  await page.addInitScript(
    ([key, data]) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, data);
    },
    [STORAGE_KEY, seed()] as const,
  );
  const dialog = page.getByRole('dialog');
  const html = page.locator('html');

  await page.goto('/');
  await expect(page.locator('.today__list').first().locator('.habit-row').first()).toBeVisible();
  await shot(page, 'today-light');

  // Finish the day: the confetti mid-burst, then the settled celebration state.
  const pendingChecks = page.locator('.today__list').first().locator('.check[aria-pressed="false"]');
  while ((await pendingChecks.count()) > 0) await pendingChecks.first().click();
  await expect(page.locator('.confetti__canvas')).toHaveCount(1);
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(DIR, 'today-light-confetti.png'), caret: 'hide' });
  await expect(page.locator('.confetti__canvas')).toHaveCount(0, { timeout: 5_000 });
  await shot(page, 'today-light-celebrate');

  // The "Not scheduled today" disclosure, open.
  const toggle = page.locator('.today__toggle');
  if ((await toggle.count()) > 0) {
    await toggle.click();
    await shot(page, 'today-light-unscheduled-open');
    await toggle.click();
  }

  await page.getByRole('button', { name: 'Add tracker', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder('e.g. Gym').fill('Evening walk');
  await shot(page, 'editor-new-light');
  await dialog.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await shot(page, 'editor-new-light-bottom');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  await openTab(page, 'Week');
  await shot(page, 'week-light');
  // Last week: the archived tracker's final days, tagged, and the "This week" pill.
  await page.getByRole('button', { name: 'Previous week' }).click();
  await expect(page.locator('.wk-eyebrow')).toContainText('Last week');
  await shot(page, 'week-light-last');
  await page.locator('.wk-eyebrow').getByRole('button', { name: 'This week' }).click();
  await expect(page.locator('.wk-eyebrow')).toHaveText('This week');

  await openTab(page, 'Progress');
  await shot(page, 'progress-light');
  await scrollMain(page, 'bottom');
  await shot(page, 'progress-light-bottom');

  await openTab(page, 'Trackers');
  await shot(page, 'trackers-light');
  await scrollMain(page, 'bottom');
  await shot(page, 'trackers-light-settings');

  await page.getByRole('radio', { name: 'Dark' }).click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await shot(page, 'trackers-dark-settings');
  await scrollMain(page, 'top');
  await shot(page, 'trackers-dark');

  await page.locator('.manage-row__main').first().click();
  await expect(dialog.getByRole('heading', { name: 'Edit tracker' })).toBeVisible();
  await shot(page, 'editor-edit-dark');
  await dialog.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await shot(page, 'editor-edit-dark-bottom');
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog.locator('.confirm')).toBeVisible();
  await shot(page, 'editor-edit-dark-confirm');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  await openTab(page, 'Progress');
  await shot(page, 'progress-dark');
  await scrollMain(page, 'bottom');
  await shot(page, 'progress-dark-bottom');

  await openTab(page, 'Week');
  await shot(page, 'week-dark');

  await openTab(page, 'Today');
  await shot(page, 'today-dark');
});

test('captures the empty first run and the pristine editor', async ({ page }) => {
  mkdirSync(DIR, { recursive: true });
  await page.goto('/');
  await expect(page.locator('.empty')).toBeVisible();
  await shot(page, 'today-light-empty');
  await page.getByRole('button', { name: 'Add your first tracker' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await shot(page, 'editor-pristine-light');
});
