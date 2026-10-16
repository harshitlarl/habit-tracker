import { expect, test as base, type Page } from '@playwright/test';

/* ---------- seed data: local dates computed here, in the same time zone as the browser ---------- */

const pad = (n: number): string => String(n).padStart(2, '0');
const key = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const shift = (d: Date, n: number): Date => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const now = new Date();
const daysAgo = (n: number): string => key(shift(now, -n));
const weekday = (d: Date): number => (d.getDay() + 6) % 7; // Mon = 0 … Sun = 6

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [0, 1, 2, 3, 4];

function seedData(): string {
  const habits = [
    { id: 'gym', name: 'Gym', emoji: '💪', color: 'terracotta', days: [0, 2, 4], createdAt: daysAgo(27), order: 0 },
    { id: 'study', name: 'Study 2 hours', emoji: '📚', color: 'slate', note: '2 hours', days: EVERY_DAY, createdAt: daysAgo(27), order: 1 },
    { id: 'wake', name: 'Wake up by 8 AM', emoji: '🌅', color: 'ochre', note: 'by 8 AM', days: WEEKDAYS, createdAt: daysAgo(12), order: 2 },
    { id: 'journal', name: 'Journal', emoji: '📝', color: 'sage', days: EVERY_DAY, createdAt: daysAgo(40), archivedAt: daysAgo(5), order: 3 },
  ];
  const completions: Record<string, Record<string, true>> = {};
  const mark = (id: string, k: string): void => {
    (completions[id] ??= {})[k] = true;
  };
  for (let n = 27; n >= 1; n -= 1) {
    const d = shift(now, -n);
    const wd = weekday(d);
    if ([0, 2, 4].includes(wd)) mark('gym', key(d));
    if (n !== 1) mark('study', key(d));
    if (n <= 12 && wd <= 4) mark('wake', key(d));
  }
  for (let n = 40; n >= 6; n -= 1) mark('journal', daysAgo(n));
  return JSON.stringify({
    state: { habits, completions, settings: { theme: 'system', installHintDismissed: true } },
    version: 1,
  });
}

/* ---------- fixtures ---------- */

interface Fixtures {
  /** Console errors and uncaught exceptions; the fixture fails the test if any were logged. */
  errors: string[];
  /** The app loaded with a month of seeded history. */
  app: Page;
}

const test = base.extend<Fixtures>({
  errors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await use(errors);
    expect(errors, 'console errors / uncaught exceptions').toEqual([]);
  },
  app: async ({ page, errors }, use) => {
    void errors;
    // Init scripts run again on reload; seed only an empty store so saved changes survive.
    await page.addInitScript((data) => {
      if (!localStorage.getItem('momentum-v1')) localStorage.setItem('momentum-v1', data);
    }, seedData());
    await page.goto('/');
    await expect(page.locator('.view')).toBeVisible();
    await use(page);
  },
});

const openTab = async (page: Page, label: string): Promise<void> => {
  await page.getByRole('button', { name: label, exact: true }).click();
};

/* ---------- tests ---------- */

test('Today lists what is due, toggles in place and updates the ring', async ({ app: page }) => {
  await expect(page.locator('h1')).toHaveText(/day$/);
  const rows = page.locator('.today__list').first().locator('.habit-row');
  const names = await rows.locator('.habit-row__name').allTextContents();
  expect(names.length).toBeGreaterThan(0);
  const ring = page.locator('.today__ring');
  await expect(ring).toHaveText(`0/${names.length}`);

  const first = rows.first().locator('.check');
  await first.click();
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  await expect(ring).toHaveText(`1/${names.length}`);
  await expect(rows.locator('.habit-row__name')).toHaveText(names); // no reordering under the finger

  await rows.first().locator('.habit-row__name').click(); // the whole row is the target
  await expect(first).toHaveAttribute('aria-pressed', 'false');
  await expect(ring).toHaveText(`0/${names.length}`);
});

test('finishing everything due switches to the celebration and fires confetti', async ({ app: page }) => {
  const checks = page.locator('.today__list').first().locator('.check');
  const count = await checks.count();
  for (let i = 0; i < count; i += 1) await checks.nth(i).click();
  await expect(page.locator('.today__motivation')).toHaveAttribute('data-tone', 'celebrate');
  await expect(page.locator('.today__section-head').first()).toContainText('All done');
  await expect(page.locator('.confetti__canvas')).toHaveCount(1);
});

test('the + button opens the editor; a saved tracker appears and survives a reload', async ({ app: page }) => {
  await page.getByRole('button', { name: 'Add tracker' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'New tracker' })).toBeVisible();
  await expect(dialog.getByPlaceholder('e.g. Gym')).toBeFocused();
  await expect(page.locator('html')).toHaveAttribute('data-sheet-open', '');

  await dialog.getByPlaceholder('e.g. Gym').fill('Evening walk');
  await dialog.getByRole('button', { name: 'Every day' }).click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('html')).not.toHaveAttribute('data-sheet-open', '');
  await expect(page.locator('.habit-row__name', { hasText: 'Evening walk' })).toBeVisible();

  await page.reload();
  await expect(page.locator('.habit-row__name', { hasText: 'Evening walk' })).toBeVisible();
});

test('Week toggles a past day and the pill returns to the current week', async ({ app: page }) => {
  await openTab(page, 'Week');
  await expect(page.locator('#week-title')).toHaveText(/\d+ \w+$/);
  await expect(page.locator('.wk-day.is-today')).toHaveCount(1);

  const cell = page.locator('.wk-cell--due:not(.is-future)').first();
  const label = await cell.getAttribute('aria-label');
  await cell.click();
  await expect(page.getByRole('button', { name: label?.replace(/not done$/, 'done') ?? '' })).toBeVisible();
  for (const future of await page.locator('.wk-cell.is-future').all()) await expect(future).toBeDisabled();

  await page.getByRole('button', { name: 'Previous week' }).click();
  await expect(page.locator('.wk-eyebrow')).toContainText('Last week');
  await page.locator('.wk-eyebrow').getByRole('button', { name: 'This week' }).click();
  await expect(page.locator('.wk-eyebrow')).toHaveText('This week');
});

test('Progress shows the overall numbers, eight weekly bars and a heatmap per tracker', async ({ app: page }) => {
  await openTab(page, 'Progress');
  await expect(page.locator('.progress__overall .stat__value')).toHaveCount(3);
  await expect(page.locator('.bars__col')).toHaveCount(8);
  await expect(page.locator('.tracker .heat')).toHaveCount(3);

  const overflow = await page.evaluate(() => {
    const main = document.querySelector('.app__main');
    return main ? main.scrollWidth - main.clientWidth : -1;
  });
  expect(overflow).toBe(0);

  await page.locator('.archived__toggle').click();
  await expect(page.getByRole('button', { name: 'Restore Journal' })).toBeVisible();
});

test('Trackers reorders with the arrows, edits in the sheet and asks before deleting', async ({ app: page }) => {
  await openTab(page, 'Trackers');
  const names = page.locator('.manage-row__name');
  const first = (await names.first().textContent()) ?? '';
  await page.getByRole('button', { name: `Move ${first} down` }).click();
  await expect(names.nth(1)).toHaveText(first);
  await page.getByRole('button', { name: `Move ${first} up` }).click();
  await expect(names.first()).toHaveText(first);

  await page.locator('.manage-row__main').first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Edit tracker' })).toBeVisible();
  await expect(dialog.getByPlaceholder('e.g. Gym')).toHaveValue(first);

  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog.getByText(`Delete ${first} and its history?`)).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(names.first()).toHaveText(first);
});

test('the theme setting updates the document and the browser chrome colour', async ({ app: page }) => {
  await openTab(page, 'Trackers');
  await page.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const { meta, bg } = await page.evaluate(() => ({
    meta: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
    bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
  }));
  expect(meta).toBe(bg);
  await page.getByRole('radio', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('a first run shows the empty state and Save waits for a name', async ({ page, errors }) => {
  void errors;
  await page.goto('/');
  await expect(page.locator('.empty__title')).toBeVisible();
  await expect(page.locator('.today__ring')).toHaveCount(0);
  await page.getByRole('button', { name: 'Add your first tracker' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
  await dialog.getByPlaceholder('e.g. Gym').fill('Gym');
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeEnabled();
  for (const tab of ['Week', 'Progress', 'Trackers']) {
    await page.keyboard.press('Escape');
    await openTab(page, tab);
    await expect(page.locator('.empty')).toHaveCount(1);
  }
});
