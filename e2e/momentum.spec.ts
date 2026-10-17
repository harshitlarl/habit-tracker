import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  TONES,
  expectHeatmapMarkContrast,
  expectTextContrast,
  expectToneContrast,
  expectWeekMarkContrast,
  type HeatContrast,
} from './helpers/contrast';

/*
 * One continuous first day with Momentum on an emulated iPhone: empty state → two trackers →
 * checking off and the celebration → the week ledger → progress → managing trackers → settings
 * (theme, backup, import, reload, reset). The steps build on each other on purpose: this is a
 * single-user, single-device product and that is how it is used. Three shorter tests follow for
 * the OS colour scheme, reduced motion and offline use.
 *
 * Every screen is also audited for text contrast (SPEC §12) in the theme it is shown in; those
 * checks are soft so a faint label is reported without hiding the rest of the day.
 *
 * Dates are computed here in the same local time zone as the browser (both run on this machine).
 */

const STORAGE_KEY = 'momentum-v1';
const WEEKDAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
const WEEKDAY_SHORT = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] as const;

const pad = (n: number): string => String(n).padStart(2, '0');
const toKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysAgo = (n: number): string => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toKey(d);
};

/** "16 October" — the app's formatLongDate. */
const longDate = (k: string): string =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long' }).format(
    new Date(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10))),
  );

const NOW = new Date();
const TODAY = toKey(NOW);
/** Monday = 0 … Sunday = 6, like the app's Weekday. */
const TODAY_IDX = (NOW.getDay() + 6) % 7;
const YESTERDAY_IDX = TODAY_IDX === 0 ? 6 : TODAY_IDX - 1;
const todayName = WEEKDAY_LONG[TODAY_IDX] ?? '';
const EVERY_DAY: readonly number[] = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS: readonly number[] = [0, 1, 2, 3, 4];
/** Gym: Mon/Wed/Fri plus today, so it is due on whatever day the suite runs. */
const GYM_DAYS: readonly number[] = [...new Set([0, 2, 4, TODAY_IDX])].sort((a, b) => a - b);
/** The preset that leaves today unscheduled. */
const OFF_TODAY_PRESET = WEEKDAYS.includes(TODAY_IDX) ? 'Weekends' : 'Weekdays';

/** Mirrors the Trackers list: "Every day" · "Weekdays" · "Weekends" · "Mo We Fr". */
function daysSummary(days: readonly number[]): string {
  if (days.length === 7) return 'Every day';
  if (days.join() === WEEKDAYS.join()) return 'Weekdays';
  if (days.join() === '5,6') return 'Weekends';
  return days.map((d) => WEEKDAY_SHORT[d] ?? '?').join(' ');
}

interface SeedHabit {
  id: string;
  name: string;
  emoji: string;
  color: string;
  note?: string;
  days: number[];
  createdAt: string;
  archivedAt?: string;
  order: number;
}
interface StoredState {
  habits: Array<{ id: string; name: string; createdAt: string; days: number[]; archivedAt?: string }>;
  completions: Record<string, Record<string, true>>;
  settings: { theme: string; installHintDismissed: boolean };
  /** Tombstones (persist version 2); absent in the version-1 records the suite seeds. */
  deletedIds?: string[];
  /** One-time tasks and their tombstones (persist version 3); absent in the seeded records. */
  tasks?: Array<{ id: string; title: string; date: string; time?: string; done: boolean }>;
  deletedTaskIds?: string[];
}
interface Stored {
  version: number;
  state: StoredState;
}
type Backup = StoredState & { version: number; exportedAt?: string };

interface SharedPayload {
  title?: string;
  files: Array<{ name: string; type: string; text: string }>;
}
type TestWindow = Window & { __momentumShared?: SharedPayload };

const TWO_TRACKERS: SeedHabit[] = [
  { id: 'gym', name: 'Gym', emoji: '💪', color: 'ochre', days: [...EVERY_DAY], createdAt: daysAgo(3), order: 0 },
  { id: 'study', name: 'Study 2 hours', emoji: '📚', color: 'slate', note: '2 hours', days: [...EVERY_DAY], createdAt: daysAgo(3), order: 1 },
];

/** Puts trackers into the store before the app boots (only when the store is still empty). */
async function seedStore(page: Page, habits: SeedHabit[]): Promise<void> {
  const data = JSON.stringify({
    version: 1,
    state: { habits, completions: {}, settings: { theme: 'system', installHintDismissed: true } },
  });
  await page.addInitScript(
    ([key, value]) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, value);
    },
    [STORAGE_KEY, data] as const,
  );
}

async function readStore(page: Page): Promise<Stored | null> {
  const raw = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
  return raw === null ? null : (JSON.parse(raw) as Stored);
}

/** Console errors + warnings and uncaught exceptions, asserted empty at the end of a test. */
function collectConsole(page: Page, ignore?: RegExp): string[] {
  const issues: string[] = [];
  page.on('console', (msg) => {
    const type = msg.type();
    if (type !== 'error' && type !== 'warning') return;
    if (ignore?.test(msg.text())) return;
    issues.push(`[console.${type}] ${msg.text()}`);
  });
  page.on('pageerror', (err) => issues.push(`[pageerror] ${err.message}`));
  return issues;
}

type Tab = 'Today' | 'Week' | 'Progress' | 'Trackers';

async function openTab(page: Page, label: Tab): Promise<void> {
  const tab = page.locator('.tabbar').getByRole('button', { name: label, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-current', 'page');
}

/** Picks a visually hidden radio (emoji, colour) through its label and confirms the selection. */
async function pickRadio(page: Page, name: string): Promise<void> {
  const radio = page.getByRole('radio', { name, exact: true });
  await page.locator('label').filter({ has: radio }).click();
  await expect(radio).toBeChecked();
}

const dayChip = (scope: Locator, day: number): Locator =>
  scope.getByRole('button', { name: WEEKDAY_LONG[day] ?? '', exact: true });

/** Toggles the Mo…Su chips until exactly `wanted` are pressed. */
async function setDays(scope: Locator, wanted: readonly number[]): Promise<void> {
  for (let d = 0; d < 7; d += 1) {
    const chip = dayChip(scope, d);
    const pressed = (await chip.getAttribute('aria-pressed')) === 'true';
    if (pressed !== wanted.includes(d)) await chip.click();
  }
  await expectDays(scope, wanted);
}

async function expectDays(scope: Locator, wanted: readonly number[]): Promise<void> {
  for (let d = 0; d < 7; d += 1) {
    await expect(dayChip(scope, d)).toHaveAttribute('aria-pressed', String(wanted.includes(d)));
  }
}

/** Every <button> on the page exposes a name: aria-label, aria-labelledby or non-hidden text. */
async function expectAllButtonsNamed(page: Page, where: string): Promise<void> {
  const unnamed = await page.evaluate(() => {
    const nameOf = (el: Element): string => {
      const label = el.getAttribute('aria-label');
      if (label && label.trim() !== '') return label;
      const by = el.getAttribute('aria-labelledby');
      if (by) {
        const text = by
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ')
          .trim();
        if (text !== '') return text;
      }
      const clone = el.cloneNode(true) as Element;
      for (const hidden of Array.from(clone.querySelectorAll('[aria-hidden="true"]'))) hidden.remove();
      const text = (clone.textContent ?? '').trim();
      if (text !== '') return text;
      return el.getAttribute('title') ?? '';
    };
    return Array.from(document.querySelectorAll('button'))
      .filter((b) => nameOf(b) === '')
      .map((b) => b.outerHTML.slice(0, 160));
  });
  expect(unnamed, `${where}: buttons without an accessible name`).toEqual([]);
}

/** Every matched element has a hit box of at least `min` × `min` CSS px. */
async function expectTapTargets(locator: Locator, min: number, what: string): Promise<void> {
  const boxes = await locator.evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return {
        w: Math.round(r.width),
        h: Math.round(r.height),
        name: el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '',
      };
    }),
  );
  expect(boxes.length, `${what}: nothing to measure`).toBeGreaterThan(0);
  expect(
    boxes.filter((b) => b.w < min || b.h < min),
    `${what}: targets smaller than ${min}px`,
  ).toEqual([]);
}

/**
 * No horizontal scroll, the content column never ends under the fixed bottom stack, and on Today the
 * weekday headline clears the header tools (the ring and the "Add tracker" button that replaced the
 * floating "+", SPEC §3.1 deviation).
 */
async function expectLayoutIntact(page: Page, where: string): Promise<void> {
  const m = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>('.app__main');
    const view = document.querySelector<HTMLElement>('.view');
    const bottom = document.querySelector<HTMLElement>('.app__bottom');
    if (!main || !view || !bottom) return null;
    main.scrollTop = main.scrollHeight;
    const result = {
      docOverflow: document.documentElement.scrollWidth - window.innerWidth,
      mainOverflow: main.scrollWidth - main.clientWidth,
      viewBottom: view.getBoundingClientRect().bottom,
      bottomTop: bottom.getBoundingClientRect().top,
      titleRight: null as number | null,
      toolsLeft: null as number | null,
    };
    main.scrollTop = 0;
    const title = document.querySelector('#today-title');
    const tools = document.querySelector('.today__tools');
    if (title && tools) {
      // The text itself, not the h1's block box, which spans the column.
      const range = document.createRange();
      range.selectNodeContents(title);
      result.titleRight = range.getBoundingClientRect().right;
      result.toolsLeft = tools.getBoundingClientRect().left;
    }
    return result;
  });
  expect(m, `${where}: layout nodes present`).not.toBeNull();
  if (!m) return;
  expect(m.docOverflow, `${where}: horizontal page scroll`).toBeLessThanOrEqual(0);
  expect(m.mainOverflow, `${where}: horizontal content scroll`).toBe(0);
  expect(m.viewBottom, `${where}: content ends under the tab bar`).toBeLessThanOrEqual(m.bottomTop);
  if (m.titleRight !== null && m.toolsLeft !== null) {
    expect(m.titleRight, `${where}: the weekday runs under the header tools`).toBeLessThanOrEqual(m.toolsLeft);
  }
}

/** The backup the journey produces: one weekday "Gym session" created eight days ago, done today, dark theme. */
function expectBackup(backup: Backup | null): void {
  expect(backup?.version).toBe(1);
  expect(backup?.habits.map((h) => h.name)).toEqual(['Gym session']);
  const gym = backup?.habits[0];
  expect(gym?.days).toEqual([0, 1, 2, 3, 4]);
  expect(gym?.createdAt).toBe(daysAgo(8));
  expect(backup?.completions[gym?.id ?? '']?.[TODAY]).toBe(true);
  expect(backup?.settings.theme).toBe('dark');
  expect(typeof backup?.exportedAt).toBe('string');
}

test.describe('Momentum on an iPhone', () => {
  test('a first day with Momentum: from the empty state to a full reset', async ({ page }, testInfo) => {
    test.slow(); // ~150 interactions in WebKit; the config's 60s is sized for a single screen
    const issues = collectConsole(page);

    const html = page.locator('html');
    const dialog = page.getByRole('dialog');
    const ring = page.locator('.today__ring');
    const dueRows = page.locator('.today__list').first().locator('.habit-row');
    const quote = page.locator('.today__motivation .quote');
    const status = page.locator('.settings__status');

    await test.step('opens on the empty Today page with the PWA head in place', async () => {
      await page.goto('/');
      await expect(page.locator('.view.today')).toBeVisible();
      expect(await page.evaluate(() => window.innerWidth)).toBe(390);

      await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /viewport-fit=cover/);
      await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute('content', 'yes');
      await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
      await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
      for (const rel of ['manifest', 'apple-touch-icon']) {
        const href = await page.locator(`link[rel="${rel}"]`).getAttribute('href');
        expect(href, `link[rel=${rel}] href`).toBeTruthy();
        const response = await page.request.get(new URL(href ?? '', page.url()).toString());
        expect(response.ok(), `${rel} → ${href} responds`).toBeTruthy();
        if (rel === 'manifest') {
          const manifest = (await response.json()) as { name?: string; display?: string; icons?: unknown[] };
          expect(manifest.name).toBe('Momentum');
          expect(manifest.display).toBe('standalone');
          expect(manifest.icons?.length ?? 0).toBeGreaterThanOrEqual(2);
        } else {
          expect(response.headers()['content-type']).toContain('image/png');
        }
      }

      await expect(page.locator('h1#today-title')).toHaveText(todayName);
      await expect(page.locator('.empty')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Add your first tracker' })).toBeVisible();
      await expect(ring).toHaveCount(0);
      // iPhone Safari, not installed: the Add-to-Home-Screen hint sits above the tab bar.
      await expect(page.locator('.install-hint')).toBeVisible();
      await expectAllButtonsNamed(page, 'empty Today');
      await expectTapTargets(page.locator('.tabbar__item'), 44, 'tab bar items');
      await expectLayoutIntact(page, 'empty Today');
      await expectTextContrast(page, 'empty Today (light)');
    });

    await test.step('sets the editorial type and the paper texture', async () => {
      const styles = await page.evaluate(async () => {
        await document.fonts.ready;
        const h1 = document.querySelector('h1');
        const texture = getComputedStyle(document.body, '::before');
        const loaded = Array.from(document.fonts)
          .filter((f) => f.status === 'loaded')
          .map((f) => `${f.family.replace(/["']/g, '')} ${f.style}`);
        return {
          h1: h1 ? getComputedStyle(h1).fontFamily : '',
          h1Size: h1 ? getComputedStyle(h1).fontSize : '',
          body: getComputedStyle(document.body).fontFamily,
          bodySize: getComputedStyle(document.body).fontSize,
          loaded,
          textureImage: texture.backgroundImage,
          textureOpacity: texture.opacity,
          texturePosition: texture.position,
          textureBlend: texture.mixBlendMode,
        };
      });
      expect(styles.h1, 'weekday headline family').toMatch(/^["']?Fraunces Variable/);
      expect(styles.h1Size, 'weekday headline size').toBe('40px');
      expect(styles.body, 'body family').toMatch(/^["']?Hanken Grotesk Variable/);
      expect(styles.bodySize).toBe('16px');
      expect(styles.loaded).toContainEqual(expect.stringMatching(/^Fraunces Variable normal/));
      expect(styles.loaded).toContainEqual(expect.stringMatching(/^Hanken Grotesk Variable normal/));
      expect(styles.textureImage).toContain('feTurbulence');
      expect(styles.texturePosition).toBe('fixed');
      expect(Number(styles.textureOpacity)).toBeCloseTo(0.035, 3);
      expect(styles.textureBlend).toBe('multiply');

      // Round-1 finding: light ochre/sage fell under 3:1. Every filled mark must clear it now.
      const tones = await expectToneContrast(page, 'light');
      await testInfo.attach('tone-contrast-light.json', {
        body: JSON.stringify(tones, null, 2),
        contentType: 'application/json',
      });
    });

    await test.step('adds "Gym": an emoji, the ochre colour, Mon/Wed/Fri plus today', async () => {
      await page.getByRole('button', { name: 'Add your first tracker' }).click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('heading', { name: 'New tracker' })).toBeVisible();
      await expect(html).toHaveAttribute('data-sheet-open', '');
      const nameField = dialog.getByPlaceholder('e.g. Gym');
      await expect(nameField).toBeFocused();
      // Save stays enabled (polish M10): a submit without a name says why, marks the field and focuses it.
      const save = dialog.getByRole('button', { name: 'Save' });
      await expect(save).toBeEnabled();
      await expect(dialog.getByText('Give it a name.')).toHaveCount(0);
      await save.click();
      await expect(dialog.getByText('Give it a name.')).toBeVisible();
      await expect(nameField).toHaveAttribute('aria-invalid', 'true');
      await expect(nameField).toHaveAccessibleDescription('Give it a name.');
      await expect(nameField).toBeFocused();
      await expect(dialog.getByRole('heading', { name: 'New tracker' })).toBeVisible(); // nothing was saved
      await expectAllButtonsNamed(page, 'New tracker sheet');
      await expectTapTargets(dialog.locator('.sheet__close'), 44, 'sheet close');
      await expectTextContrast(page, 'New tracker sheet (light)');
      await testInfo.attach('placeholder-style.json', {
        body: JSON.stringify(
          await dialog.locator('input[placeholder]').evaluateAll((els) =>
            els.map((el) => {
              const ps = getComputedStyle(el, '::placeholder');
              return { placeholder: el.getAttribute('placeholder'), color: ps.color, opacity: ps.opacity };
            }),
          ),
        ),
        contentType: 'application/json',
      });

      await nameField.fill('Gym');
      await expect(dialog.getByText('Give it a name.')).toHaveCount(0); // the error follows the field live
      await expect(nameField).not.toHaveAttribute('aria-invalid', 'true');
      // A typed emoji (even a ZWJ sequence) becomes the face; picking from the grid clears the field.
      const custom = dialog.getByPlaceholder('Or type your own');
      await custom.fill('🏋️‍♀️');
      await expect(dialog.locator('.editor__preview')).toHaveText('🏋️‍♀️');
      await pickRadio(page, 'Strength');
      await expect(dialog.locator('.editor__preview')).toHaveText('💪');
      await expect(custom).toHaveValue('');
      await pickRadio(page, 'Ochre');
      await expectDays(dialog, EVERY_DAY); // every day by default
      await setDays(dialog, GYM_DAYS);
      await expect(dialog.getByRole('button', { name: 'Save' })).toBeEnabled();
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(html).not.toHaveAttribute('data-sheet-open', '');

      await expect(page.locator('.empty')).toHaveCount(0);
      await expect(dueRows.locator('.habit-row__name')).toHaveText(['Gym']);
      await expect(dueRows.first()).toHaveClass(/tone-ochre/);
      await expect(dueRows.first().locator('.habit-row__emoji')).toHaveText('💪');
    });

    await test.step('adds "Study 2 hours" every day with a note', async () => {
      // The header "+" next to the ring (it replaced the floating button, polish V1).
      await page.getByRole('button', { name: 'Add tracker', exact: true }).click();
      await expect(dialog.getByRole('heading', { name: 'New tracker' })).toBeVisible();
      await dialog.getByPlaceholder('e.g. Gym').fill('Study 2 hours');
      await pickRadio(page, 'Read');
      await dialog.getByPlaceholder('e.g. 2 hours, by 8 AM').fill('2 hours');
      await dialog.getByRole('button', { name: 'Weekends' }).click();
      await expectDays(dialog, [5, 6]);
      await dialog.getByRole('button', { name: 'Every day' }).click();
      await expectDays(dialog, EVERY_DAY);
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog).toHaveCount(0);
    });

    await test.step('Today lists both as due, with the big checks and the italic pull-quote', async () => {
      await expect(dueRows.locator('.habit-row__name')).toHaveText(['Gym', 'Study 2 hours']);
      await expect(dueRows.nth(1).locator('.habit-row__meta')).toHaveText('2 hours');
      await expect(page.locator('.today__toggle')).toHaveCount(0); // nothing is unscheduled today
      await expect(ring).toHaveText('0/2');
      await expect(ring).toHaveAttribute('aria-valuenow', '0');
      await expect(page.locator('.today__section-head').first()).toContainText('2 left');
      await expect(page.locator('.habit-row__streak')).toHaveCount(0); // no streak chips below 2 days

      await expectTapTargets(page.locator('.check'), 44, 'Today checks');
      const box = await page.locator('.check').first().boundingBox();
      expect(box?.width ?? 0, 'the Today check is the oversized 52px one').toBeGreaterThanOrEqual(52);

      await expect(quote).toBeVisible();
      const quoteStyle = await quote.evaluate((el) => {
        const s = getComputedStyle(el);
        return { family: s.fontFamily, style: s.fontStyle };
      });
      expect(quoteStyle.family).toMatch(/^["']?Fraunces Variable/);
      expect(quoteStyle.style).toBe('italic');
      await expectAllButtonsNamed(page, 'Today');
      await expectLayoutIntact(page, 'Today');
      await expectTextContrast(page, 'Today (light)');
    });

    await test.step('checking both fills the ring, fires confetti and changes the motivation line', async () => {
      const before = (await quote.textContent()) ?? '';
      expect(before.length).toBeGreaterThan(0);
      expect(before.length, 'motivation titles stay short').toBeLessThanOrEqual(60);

      // A Check keeps one name ("Mark Gym done"); aria-pressed carries the state, as a toggle button should.
      const gymCheck = page.getByRole('button', { name: 'Mark Gym done', exact: true });
      const studyCheck = page.getByRole('button', { name: 'Mark Study 2 hours done', exact: true });
      await expect(gymCheck).toHaveAttribute('aria-pressed', 'false');
      await gymCheck.click();
      await expect(gymCheck).toHaveAttribute('aria-pressed', 'true');
      await expect(ring).toHaveText('1/2');
      await expect(dueRows.locator('.habit-row__name')).toHaveText(['Gym', 'Study 2 hours']); // nothing moved
      await expect(dueRows.first()).toHaveClass(/is-done/);
      await expect(page.locator('.today__motivation')).not.toHaveAttribute('data-tone', 'celebrate');
      const partial = (await quote.textContent()) ?? '';
      expect(partial.length, 'motivation titles stay short').toBeLessThanOrEqual(60);

      // Deterministic: undoing returns to exactly the same line, not a re-rolled one.
      await gymCheck.click();
      await expect(gymCheck).toHaveAttribute('aria-pressed', 'false');
      await expect(ring).toHaveText('0/2');
      await expect(quote).toHaveText(before);
      await gymCheck.click();
      await expect(ring).toHaveText('1/2');
      await expect(quote).toHaveText(partial);

      await studyCheck.click();
      await expect(studyCheck).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.confetti__canvas')).toHaveCount(1);
      await expect(ring).toHaveText('2/2');
      await expect(ring).toHaveAttribute('aria-valuenow', '100');
      await expect(page.locator('.today__motivation')).toHaveAttribute('data-tone', 'celebrate');
      await expect(quote).not.toHaveText(before);
      await expect(quote).not.toHaveText(partial);
      await expect(page.locator('.today__section-head').first()).toContainText('All done');
      await expect(page.locator('.confetti__canvas')).toHaveCount(0, { timeout: 5_000 }); // the burst cleans up
    });

    await test.step("Week shows filled dots in today's column and disabled past/future cells", async () => {
      await openTab(page, 'Week');
      await expect(page.locator('#week-title')).toBeVisible();
      await expect(page.locator('.wk-day__name')).toHaveText([...WEEKDAY_SHORT]);
      await expect(page.locator('.wk-day.is-today')).toHaveCount(1);
      await expect(page.locator('.wk-day').nth(TODAY_IDX)).toHaveClass(/is-today/);

      const rows = page.locator('.wk-row');
      await expect(rows).toHaveCount(2);
      await expect(rows.locator('.wk-name')).toHaveText(['Gym', 'Study 2 hours']);
      for (let r = 0; r < 2; r += 1) {
        const cells = rows.nth(r).locator('.wk-cell');
        await expect(cells).toHaveCount(7);
        await expect(cells.nth(TODAY_IDX)).toBeEnabled();
        await expect(cells.nth(TODAY_IDX)).toHaveClass(/wk-cell--done/);
        // A cell is a toggle button: aria-pressed carries done, the name stays "Gym, Saturday 17 October" (V5).
        await expect(cells.nth(TODAY_IDX)).toHaveAttribute('aria-pressed', 'true');
        await expect(cells.nth(TODAY_IDX)).toHaveAttribute(
          'aria-label',
          `${r === 0 ? 'Gym' : 'Study 2 hours'}, ${todayName} ${longDate(TODAY)}`,
        );
        for (let d = 0; d < 7; d += 1) {
          if (d === TODAY_IDX) continue;
          // Created today: earlier days are outside the tracker's life, later days are in the future.
          await expect(cells.nth(d)).toBeDisabled();
          await expect(cells.nth(d)).toHaveClass(d < TODAY_IDX ? /wk-cell--outside/ : /is-future/);
        }
      }
      await expectTapTargets(page.locator('.wk-cell'), 44, 'week cells');
      await expectTapTargets(page.locator('.wk-nav__btn'), 44, 'week nav');
      await expect(page.locator('.wk-foot__cell').nth(TODAY_IDX)).toContainText('2/2');
      await expect(page.locator('.wk-summary__text')).toContainText('2 of 2');
      await expect(page.locator('.wk-foot__cell').nth(TODAY_IDX)).toHaveClass(/is-perfect/);
      if (TODAY_IDX !== 6) await expect(page.locator('.wk-summary__note')).toHaveText(`Through ${todayName}`);
      await expectAllButtonsNamed(page, 'Week');
      await expectLayoutIntact(page, 'Week');
      // Includes the perfect-day total sitting on today's ember band and the "Through …" note.
      await expectTextContrast(page, 'Week (light, perfect day)');
    });

    await test.step('Week navigates with ‹ › and the "This week" pill', async () => {
      const title = page.locator('#week-title');
      const eyebrow = page.locator('.wk-eyebrow');
      const pill = eyebrow.getByRole('button', { name: 'This week' });
      const current = (await title.textContent()) ?? '';
      expect(current).toMatch(/\d/);
      await expect(eyebrow).toHaveText('This week');
      await expect(pill).toHaveCount(0);

      await page.getByRole('button', { name: 'Previous week' }).click();
      await expect(eyebrow).toContainText('Last week');
      await expect(pill).toBeVisible();
      await expect(title).not.toHaveText(current);
      await expect(page.locator('.wk-none')).toBeVisible(); // neither tracker existed last week

      await page.getByRole('button', { name: 'Next week' }).click();
      await expect(eyebrow).toHaveText('This week');
      await page.getByRole('button', { name: 'Next week' }).click();
      await expect(eyebrow).toContainText('Next week');
      const futureCells = page.locator('.wk-cell');
      await expect(futureCells).toHaveCount(14);
      for (const cell of await futureCells.all()) {
        await expect(cell).toBeDisabled();
        await expect(cell).toHaveClass(/is-future/);
      }

      await pill.click();
      await expect(eyebrow).toHaveText('This week');
      await expect(title).toHaveText(current);
    });

    await test.step('toggles a past day once the trackers have some history', async () => {
      // Both trackers were born today, so every earlier cell is rightly disabled (SPEC §3.2).
      // Give them a week of life — as if they had been created last week — and reload.
      await page.evaluate(
        ([key, created]) => {
          const raw = localStorage.getItem(key);
          if (!raw) throw new Error('store missing');
          const data = JSON.parse(raw) as { state: { habits: Array<{ createdAt: string }> } };
          for (const h of data.state.habits) h.createdAt = created;
          localStorage.setItem(key, JSON.stringify(data));
        },
        [STORAGE_KEY, daysAgo(8)] as const,
      );
      await page.reload();
      await expect(ring).toHaveText('2/2'); // today's checks survived the reload

      await openTab(page, 'Week');
      if (TODAY_IDX === 0) {
        await page.getByRole('button', { name: 'Previous week' }).click();
        await expect(page.locator('.wk-eyebrow')).toContainText('Last week');
      }
      const studyRow = page.locator('.wk-row').filter({ hasText: 'Study 2 hours' });
      const cell = studyRow.locator('.wk-cell').nth(YESTERDAY_IDX);
      await expect(cell).toBeEnabled();
      await expect(cell).toHaveClass(/wk-cell--due/);
      await expect(cell).toHaveAttribute('aria-pressed', 'false');
      const cellName = (await cell.getAttribute('aria-label')) ?? '';
      await cell.click();
      await expect(cell).toHaveClass(/wk-cell--done/);
      await expect(cell).toHaveAttribute('aria-pressed', 'true');
      await expect(cell, 'the name does not change under the tap').toHaveAttribute('aria-label', cellName);
      await cell.click();
      await expect(cell).toHaveClass(/wk-cell--due/);
      await cell.click(); // leave it done: Study now has a two-day streak
      await expect(cell).toHaveClass(/wk-cell--done/);
      const dueYesterday = GYM_DAYS.includes(YESTERDAY_IDX) ? 2 : 1;
      await expect(page.locator('.wk-foot__cell').nth(YESTERDAY_IDX)).toContainText(`1/${dueYesterday}`);

      await openTab(page, 'Today');
      await expect(dueRows.filter({ hasText: 'Study 2 hours' }).locator('.habit-row__streak')).toContainText('2');
      await expect(dueRows.filter({ hasText: 'Gym' }).locator('.habit-row__streak')).toHaveCount(0);
    });

    await test.step('Progress shows the streaks, eight weekly bars and a heatmap per tracker', async () => {
      await openTab(page, 'Progress');
      const overall = page.locator('.progress__overall .stat__value');
      await expect(overall).toHaveCount(3);
      expect(Number(await overall.nth(0).textContent()), 'perfect-day streak').toBeGreaterThanOrEqual(1);
      expect(Number(await overall.nth(1).textContent()), 'total completions').toBe(3);
      await expect(overall.nth(2)).toContainText('%');
      await expect(page.locator('.bars__col')).toHaveCount(8);
      await expect(page.locator('.bars__col.is-current .bars__bar')).toHaveCount(1);

      const cards = page.locator('.tracker');
      await expect(cards).toHaveCount(2);
      await expect(cards.locator('h3')).toHaveText(['Gym', 'Study 2 hours']);
      const gym = cards.filter({ hasText: 'Gym' });
      const study = cards.filter({ hasText: 'Study 2 hours' });
      expect(Number(await gym.locator('.stat__value').first().textContent()), 'Gym streak').toBeGreaterThanOrEqual(1);
      expect(Number(await study.locator('.stat__value').first().textContent()), 'Study streak').toBe(2);
      for (const card of [gym, study]) {
        await expect(card.locator('.heat')).toHaveCount(1);
        await expect(card.locator('.heat__cell')).toHaveCount(12 * 7);
      }
      await expect(gym.locator('.heat__cell.is-done')).toHaveCount(1);
      await expect(study.locator('.heat__cell.is-done')).toHaveCount(2);
      expect(await study.locator('.heat__cell.is-missed').count()).toBeGreaterThanOrEqual(1);
      await expect(page.locator('.archived')).toHaveCount(0);
      await expectAllButtonsNamed(page, 'Progress');
      await expectLayoutIntact(page, 'Progress');
      await expectTextContrast(page, 'Progress (light)');
    });

    await test.step('Trackers: reorder with the arrows, rename, change days, archive', async () => {
      await openTab(page, 'Trackers');
      const names = page.locator('.manage-row__name');
      await expect(names).toHaveText(['Gym', 'Study 2 hours']);
      await expect(page.locator('.manage-row__days')).toHaveText([daysSummary(GYM_DAYS), 'Every day']);
      await expect(page.locator('.manage-row__note')).toHaveText(['· 2 hours']);
      await expect(page.locator('.manage__sub')).toHaveText('2 active');
      await expectTapTargets(page.locator('.manage-row__move'), 44, 'reorder arrows');
      await expectAllButtonsNamed(page, 'Trackers');
      await expectLayoutIntact(page, 'Trackers');
      await expectTextContrast(page, 'Trackers + Settings (light)');

      await expect(page.getByRole('button', { name: 'Move Gym up' })).toBeDisabled();
      await page.getByRole('button', { name: 'Move Gym down' }).click();
      await expect(names).toHaveText(['Study 2 hours', 'Gym']);
      await expect(page.getByRole('button', { name: 'Move Gym down' })).toBeDisabled();
      await page.getByRole('button', { name: 'Move Gym up' }).click();
      await expect(names).toHaveText(['Gym', 'Study 2 hours']);

      await page.locator('.manage-row__main').filter({ hasText: 'Gym' }).click();
      await expect(dialog.getByRole('heading', { name: 'Edit tracker' })).toBeVisible();
      const nameInput = dialog.getByPlaceholder('e.g. Gym');
      await expect(nameInput).toHaveValue('Gym');
      await expect(dialog.getByRole('radio', { name: 'Ochre' })).toBeChecked();
      await expect(dialog.getByRole('radio', { name: 'Strength' })).toBeChecked();
      await expectDays(dialog, GYM_DAYS);
      await nameInput.fill('Gym session');
      await dialog.getByRole('button', { name: 'Weekdays' }).click();
      await expectDays(dialog, WEEKDAYS);
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(names).toHaveText(['Gym session', 'Study 2 hours']);
      await expect(page.locator('.manage-row__days').first()).toHaveText('Weekdays');

      await page.locator('.manage-row__main').filter({ hasText: 'Study 2 hours' }).click();
      await expect(dialog.getByRole('heading', { name: 'Edit tracker' })).toBeVisible();
      await dialog.getByRole('button', { name: 'Archive' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(names).toHaveText(['Gym session']);
      await expect(page.locator('.manage__sub')).toHaveText('1 active · 1 archived');
    });

    await test.step('restores the archived tracker from Progress', async () => {
      // Round-1 bug: archiving on a day already checked off turned that check into a bonus and
      // cut the streak to 1. The archive must keep the history exactly as the owner saw it a
      // moment earlier: Study was created 8 days ago (9 due days), done yesterday and today.
      await openTab(page, 'Progress');
      await expect(page.locator('.tracker')).toHaveCount(1);
      const archived = page.locator('.archived');
      await expect(archived).toBeVisible();
      await expect(archived.locator('.archived__count')).toHaveText('1');
      await archived.locator('.archived__toggle').click();
      await expect(archived.locator('.archived__toggle')).toHaveAttribute('aria-expanded', 'true');
      await expect(archived.locator('.archived__name')).toHaveText(['Study 2 hours']);
      const facts = archived.locator('.archived__facts');
      await expect(facts).toContainText('Best 2 days');
      await expect(facts).toContainText('2 done');
      await expect(facts).toContainText('22%'); // 2 of 9 due
      // archivedAt is stored as tomorrow (an exclusive bound) so today's check stays a scheduled
      // completion; the card names the last active day, today, rather than the stored date.
      await expect(facts, 'last active day on the card').toContainText(`Last day ${longDate(TODAY)}`);
      await expectAllButtonsNamed(page, 'Progress (archived open)');

      // The ledger keeps today's check as a real completion (not a bonus) and tags the row.
      await openTab(page, 'Week');
      const studyRow = page.locator('.wk-row').filter({ hasText: 'Study 2 hours' });
      await expect(studyRow.locator('.wk-tag')).toHaveText('Archived');
      await expect(studyRow.locator('.wk-cell').nth(TODAY_IDX)).toHaveClass(/wk-cell--done/);
      await expect(studyRow.locator('.wk-cell').nth(TODAY_IDX)).not.toHaveClass(/wk-cell--bonus/);
      await expectTextContrast(page, 'Week (light, archived row)');

      // …and it has left Today altogether.
      await openTab(page, 'Today');
      await expect(page.locator('.habit-row').filter({ hasText: 'Study 2 hours' })).toHaveCount(0);

      await openTab(page, 'Progress');
      await expect(archived.locator('.archived__toggle')).toHaveAttribute('aria-expanded', 'true'); // remembered
      await page.getByRole('button', { name: 'Restore Study 2 hours' }).click();
      await expect(page.locator('.tracker')).toHaveCount(2);
      await expect(page.locator('.archived')).toHaveCount(0);
      // Restored: today is scheduled again, so the two-day streak is back.
      const restored = page.locator('.tracker').filter({ hasText: 'Study 2 hours' });
      expect(Number(await restored.locator('.stat__value').first().textContent()), 'Study streak after restore').toBe(2);
    });

    await test.step('deletes a tracker through the inline confirmation', async () => {
      await openTab(page, 'Trackers');
      const names = page.locator('.manage-row__name');
      await expect(names).toHaveText(['Gym session', 'Study 2 hours']);
      await page.locator('.manage-row__main').filter({ hasText: 'Study 2 hours' }).click();
      const deleteButton = dialog.getByRole('button', { name: 'Delete', exact: true });
      await deleteButton.click();

      const confirm = dialog.locator('.confirm');
      await expect(confirm).toBeVisible();
      await expect(confirm).toContainText('Delete Study 2 hours and its history?');
      await expect(confirm).toContainText('2 check-ins will be removed');
      await expect(dialog.getByRole('button', { name: 'Archive' })).toHaveCount(0); // the question replaces the actions
      await confirm.getByRole('button', { name: 'Cancel' }).click();
      await expect(confirm).toHaveCount(0);
      await expect(deleteButton).toBeFocused();
      await expect(names).toHaveText(['Gym session', 'Study 2 hours']);

      await deleteButton.click();
      await dialog.locator('.confirm').getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(names).toHaveText(['Gym session']);
      await expect(page.locator('.manage__sub')).toHaveText('1 active');

      const stored = await readStore(page);
      expect(stored?.state.habits.map((h) => h.name)).toEqual(['Gym session']);
      expect(Object.keys(stored?.state.completions ?? {}), 'its completions went with it').toEqual([
        stored?.state.habits[0]?.id,
      ]);
    });

    await test.step('a tracker not scheduled today can still be checked, as a bonus', async () => {
      await page.locator('.manage-row__main').filter({ hasText: 'Gym session' }).click();
      await dialog.getByRole('button', { name: OFF_TODAY_PRESET }).click();
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog).toHaveCount(0);

      await openTab(page, 'Today');
      await expect(ring).toHaveCount(0); // nothing due, so no ring
      await expect(page.locator('.today__rest')).toHaveText(`Nothing is scheduled on ${todayName}s.`);
      await expect(page.locator('.today__section-head').first()).toContainText('Rest day');
      const toggle = page.locator('.today__toggle');
      // On a rest day the disclosure starts open: nothing else competes for attention (polish V2).
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(toggle).toContainText('1');
      await expect(toggle).toHaveAccessibleName(/^Not scheduled today\s*,\s*1\s+tracker$/);
      const bonusRow = page.locator('.today__list .habit-row').filter({ hasText: 'Gym session' });
      // It was checked earlier today while still scheduled; that check now reads as a bonus.
      await expect(bonusRow).toHaveClass(/is-done/);
      await expect(bonusRow.locator('.habit-row__bonus')).toHaveText('Bonus');
      const bonusCheck = bonusRow.getByRole('button', { name: 'Mark Gym session done', exact: true });
      await expect(bonusCheck).toHaveAttribute('aria-pressed', 'true');
      await bonusCheck.click();
      await expect(bonusCheck).toHaveAttribute('aria-pressed', 'false');
      await expect(bonusRow).not.toHaveClass(/is-done/);
      await expect(bonusRow.locator('.habit-row__bonus')).toHaveCount(0);
      await bonusCheck.click();
      await expect(bonusRow.locator('.habit-row__bonus')).toHaveText('Bonus');
      await expect(ring).toHaveCount(0); // a bonus never joins the due denominator
      await expectLayoutIntact(page, 'Today (rest day)');

      await openTab(page, 'Week');
      const cell = page.locator('.wk-row').filter({ hasText: 'Gym session' }).locator('.wk-cell').nth(TODAY_IDX);
      await expect(cell).toHaveClass(/wk-cell--bonus/);
      await expect(cell).toHaveAttribute('aria-label', /, bonus$/);
      await expect(cell).toHaveAttribute('aria-pressed', 'true');

      // Back to weekdays for the rest of the run.
      await openTab(page, 'Trackers');
      await page.locator('.manage-row__main').filter({ hasText: 'Gym session' }).click();
      await dialog.getByRole('button', { name: 'Weekdays' }).click();
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator('.manage-row__days').first()).toHaveText('Weekdays');
    });

    await test.step('Settings: Dark switches the document theme, the chrome colour and the texture', async () => {
      const theme = page.getByRole('radiogroup', { name: 'Theme' });
      await expect(theme.getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'true');
      await expect(html).toHaveAttribute('data-theme', 'light');
      await theme.getByRole('radio', { name: 'Dark' }).click();
      await expect(html).toHaveAttribute('data-theme', 'dark');
      await expect(theme.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
      const dark = await page.evaluate(() => ({
        bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim().toLowerCase(),
        bodyBg: getComputedStyle(document.body).backgroundColor,
        themeColor: Array.from(document.querySelectorAll('meta[name="theme-color"]')).map((m) =>
          (m.getAttribute('content') ?? '').toLowerCase(),
        ),
        textureOpacity: getComputedStyle(document.body, '::before').opacity,
      }));
      expect(dark.bg).toBe('#15110e');
      expect(dark.bodyBg).toBe('rgb(21, 17, 14)');
      expect(dark.themeColor.length).toBeGreaterThan(0);
      expect(dark.themeColor.every((c) => c === '#15110e'), 'theme-color follows --bg').toBe(true);
      expect(Number(dark.textureOpacity)).toBeCloseTo(0.06, 3);
      await expectLayoutIntact(page, 'Trackers (dark)');
      const tones = await expectToneContrast(page, 'dark');
      await testInfo.attach('tone-contrast-dark.json', {
        body: JSON.stringify(tones, null, 2),
        contentType: 'application/json',
      });
      await expectTextContrast(page, 'Trackers + Settings (dark)');

      // The editor sheet in dark, with the delete question open.
      await page.locator('.manage-row__main').filter({ hasText: 'Gym session' }).click();
      await expect(dialog.getByRole('heading', { name: 'Edit tracker' })).toBeVisible();
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(dialog.locator('.confirm')).toBeVisible();
      await expectTextContrast(page, 'Edit tracker sheet + delete question (dark)');
      await dialog.locator('.confirm').getByRole('button', { name: 'Cancel' }).click();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    });

    const backupPath = testInfo.outputPath(`momentum-backup-${TODAY}.json`);

    await test.step('Export hands the backup to the iOS share sheet', async () => {
      // Safari exposes navigator.share here; headless WebKit "shares" into the void, so capture the payload.
      await page.evaluate(() => {
        const w = window as TestWindow;
        Object.defineProperty(navigator, 'canShare', { configurable: true, writable: true, value: () => true });
        Object.defineProperty(navigator, 'share', {
          configurable: true,
          writable: true,
          value: async (data: ShareData) => {
            const files = await Promise.all(
              (data.files ?? []).map(async (f) => ({ name: f.name, type: f.type, text: await f.text() })),
            );
            w.__momentumShared = { title: data.title, files };
          },
        });
      });
      await page.getByRole('button', { name: 'Export' }).click();
      await expect(status).toHaveText(`Backup momentum-backup-${TODAY}.json is on its way.`);
      const shared = await page.evaluate(() => (window as TestWindow).__momentumShared);
      expect(shared?.title).toBe('Momentum backup');
      expect(shared?.files.map((f) => [f.name, f.type])).toEqual([[`momentum-backup-${TODAY}.json`, 'application/json']]);
      expectBackup(JSON.parse(shared?.files[0]?.text ?? 'null') as Backup | null);
    });

    await test.step('…and downloads it where there is no share sheet', async () => {
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'share', { configurable: true, writable: true, value: undefined });
        Object.defineProperty(navigator, 'canShare', { configurable: true, writable: true, value: undefined });
      });
      const downloadPromise = page.waitForEvent('download', { timeout: 15_000 });
      await page.getByRole('button', { name: 'Export' }).click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe(`momentum-backup-${TODAY}.json`);
      await download.saveAs(backupPath);
      expectBackup(JSON.parse(readFileSync(backupPath, 'utf8')) as Backup);
      await expect(status).toHaveText(`Saved momentum-backup-${TODAY}.json.`);
    });

    await test.step('Import refuses unreadable and foreign files with a readable reason', async () => {
      const notJson = testInfo.outputPath('not-a-backup.json');
      writeFileSync(notJson, '{ this is not json');
      await page.locator('input[type="file"]').setInputFiles(notJson);
      await expect(status).toHaveText('not-a-backup.json is not readable JSON.');
      await expect(status).toHaveClass(/is-error/);

      const wrongVersion = testInfo.outputPath('future-backup.json');
      writeFileSync(wrongVersion, JSON.stringify({ version: 2, habits: [], completions: {}, settings: {} }));
      await page.locator('input[type="file"]').setInputFiles(wrongVersion);
      await expect(status).toHaveText('Could not import future-backup.json: Unsupported backup version: 2.');
      await expect(page.locator('.settings .confirm')).toHaveCount(0); // nothing to confirm
      await expect(page.locator('.manage-row__name')).toHaveText(['Gym session']); // nothing replaced
    });

    await test.step('Import of the real backup asks first, then succeeds', async () => {
      await page.locator('input[type="file"]').setInputFiles(backupPath);
      const confirm = page.locator('.settings .confirm');
      await expect(confirm).toContainText('Replace your data with this backup?');
      await expect(confirm).toContainText('1 tracker');
      await expect(confirm).toContainText('1 check-in');
      await confirm.getByRole('button', { name: 'Replace' }).click();
      await expect(confirm).toHaveCount(0);
      await expect(status).toContainText('Imported 1 tracker · 1 check-in');
      await expect(status).not.toHaveClass(/is-error/);
      await expect(page.locator('.manage-row__name')).toHaveText(['Gym session']);
    });

    await test.step('data, theme and the dismissed install hint survive a reload', async () => {
      await page.getByRole('button', { name: 'Dismiss install hint' }).click();
      await expect(page.locator('.install-hint')).toHaveCount(0);

      await page.reload();
      await expect(page.locator('.view.today')).toBeVisible();
      await expect(html).toHaveAttribute('data-theme', 'dark');
      await expect(page.locator('.install-hint')).toHaveCount(0);

      const stored = await readStore(page);
      expect(stored, `localStorage["${STORAGE_KEY}"] is present`).not.toBeNull();
      expect(stored?.version).toBe(3); // persist v2 added tombstones, v3 one-time tasks; backups stay at version 1
      expect(stored?.state.habits.map((h) => h.name)).toEqual(['Gym session']);
      expect(stored?.state.settings).toEqual({ theme: 'dark', installHintDismissed: true });

      if (WEEKDAYS.includes(TODAY_IDX)) {
        await expect(dueRows.locator('.habit-row__name')).toHaveText(['Gym session']);
        await expect(ring).toHaveText('1/1');
        await expect(page.locator('.today__toggle')).toHaveCount(0);
      } else {
        await expect(page.locator('.today__rest')).toHaveText(`Nothing is scheduled on ${todayName}s.`);
        await expect(page.locator('.today__toggle')).toBeVisible();
        await expect(ring).toHaveCount(0);
      }
      await expectLayoutIntact(page, 'Today (dark)');
      await expectTextContrast(page, 'Today (dark)');
    });

    await test.step('Week and Progress keep their contrast in dark mode', async () => {
      await openTab(page, 'Week');
      await expect(page.locator('.wk-day.is-today')).toHaveCount(1);
      await expectLayoutIntact(page, 'Week (dark)');
      await expectTextContrast(page, 'Week (dark)');
      await openTab(page, 'Progress');
      await expect(page.locator('.bars__col')).toHaveCount(8);
      await expectLayoutIntact(page, 'Progress (dark)');
      await expectTextContrast(page, 'Progress (dark)');
    });

    await test.step('Reset clears everything after the inline confirmation', async () => {
      await openTab(page, 'Trackers');
      await page.getByRole('button', { name: 'Reset this device' }).click();
      const confirm = page.locator('.settings__danger .confirm');
      // The button, the question and the confirm all say "reset" (polish M5).
      await expect(confirm).toContainText('Reset this device?');
      await expect(confirm).toContainText('Every tracker, check-in and task on this device will be removed');
      await confirm.getByRole('button', { name: 'Cancel' }).click();
      await expect(confirm).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Reset this device' })).toBeFocused();

      await page.getByRole('button', { name: 'Reset this device' }).click();
      await page.locator('.settings__danger .confirm').getByRole('button', { name: 'Reset', exact: true }).click();
      // The outcome is announced in the Reset card itself, not under Your data (polish M3).
      await expect(page.locator('.settings__reset-status')).toHaveText('Everything has been cleared.');
      await expect(status).toHaveText('');
      await expect(page.locator('.manage-row')).toHaveCount(0);
      await expect(page.locator('.empty')).toBeVisible();
      await expect(html).toHaveAttribute('data-theme', 'light'); // back to System, which is light here

      const stored = await readStore(page);
      expect(stored?.state).toEqual({
        habits: [],
        completions: {},
        settings: { theme: 'system', installHintDismissed: false },
        deletedIds: [],
        tasks: [],
        deletedTaskIds: [],
      });

      await openTab(page, 'Today');
      await expect(page.locator('.empty')).toBeVisible();
      await expect(ring).toHaveCount(0);
    });

    await test.step('logged nothing to the console', async () => {
      const pwa = await page.evaluate(() => ({
        serviceWorkerApi: 'serviceWorker' in navigator,
        controlled: Boolean(navigator.serviceWorker?.controller),
      }));
      await testInfo.attach('pwa-runtime.json', { body: JSON.stringify(pwa), contentType: 'application/json' });
      expect(issues, 'console errors/warnings and page errors during the run').toEqual([]);
    });
  });

  test('follows the OS colour scheme live while the theme is System', async ({ page }) => {
    const issues = collectConsole(page);
    await seedStore(page, TWO_TRACKERS);
    await page.goto('/');
    const html = page.locator('html');
    const bodyBg = (): Promise<string> => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await expect(html).toHaveAttribute('data-theme', 'light');
    expect(await bodyBg()).toBe('rgb(244, 238, 226)');

    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(html).toHaveAttribute('data-theme', 'dark');
    expect(await bodyBg()).toBe('rgb(21, 17, 14)');
    await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute('content', /^#15110e$/i);

    await page.emulateMedia({ colorScheme: 'light' });
    await expect(html).toHaveAttribute('data-theme', 'light');
    expect(await bodyBg()).toBe('rgb(244, 238, 226)');

    // An explicit choice wins over the OS.
    await openTab(page, 'Trackers');
    await page.getByRole('radio', { name: 'Light' }).click();
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(html).toHaveAttribute('data-theme', 'light');
    await page.getByRole('radio', { name: 'System' }).click();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    expect(issues).toEqual([]);
  });

  test('respects prefers-reduced-motion: celebration without confetti', async ({ page }) => {
    const issues = collectConsole(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await seedStore(page, TWO_TRACKERS);
    await page.goto('/');
    const checks = page.locator('.today__list').first().locator('.check');
    await expect(checks).toHaveCount(2);
    await checks.nth(0).click();
    await checks.nth(1).click();
    await expect(page.locator('.today__ring')).toHaveText('2/2');
    await expect(page.locator('.today__motivation')).toHaveAttribute('data-tone', 'celebrate');
    await page.waitForTimeout(500);
    await expect(page.locator('.confetti__canvas')).toHaveCount(0);

    // Sheets still open and close, just without the slide.
    await page.getByRole('button', { name: 'Add tracker', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    // The sheet wires its Escape handler in the effect that also sets data-sheet-open; wait for that.
    await expect(page.locator('html')).toHaveAttribute('data-sheet-open', '');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(issues).toEqual([]);
  });

  test('Week marks for bonus and unscheduled days keep 3:1 on the paper and on today\'s band, in both themes', async ({
    page,
  }, testInfo) => {
    const issues = collectConsole(page);
    // One tracker per tone, scheduled only on tomorrow's weekday: today and the same weekday last week are
    // unscheduled, and both are checked off — bonus marks on today's band and on the paper of last week.
    // "Rest" has the same days and no check-ins: dashes in both places. Same seed whatever the weekday.
    const onlyTomorrow = [(TODAY_IDX + 1) % 7];
    const habits: SeedHabit[] = [...TONES, 'rest'].map((tone, order) => ({
      id: `mark-${tone}`,
      name: tone === 'rest' ? 'Rest' : tone.charAt(0).toUpperCase() + tone.slice(1),
      emoji: '⭐',
      color: tone === 'rest' ? 'graphite' : tone,
      days: onlyTomorrow,
      createdAt: daysAgo(14),
      order,
    }));
    const completions: Record<string, Record<string, true>> = {};
    for (const tone of TONES) completions[`mark-${tone}`] = { [TODAY]: true, [daysAgo(7)]: true };
    const data = JSON.stringify({
      version: 1,
      state: { habits, completions, settings: { theme: 'system', installHintDismissed: true } },
    });
    await page.addInitScript(
      ([key, value]) => {
        if (!localStorage.getItem(key)) localStorage.setItem(key, value);
      },
      [STORAGE_KEY, data] as const,
    );
    await page.goto('/');
    await openTab(page, 'Week');
    await expect(page.locator('.wk-row')).toHaveCount(TONES.length + 1);

    const report: Record<string, unknown> = {};
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      // This week: today's column sits on the ember band.
      await expect(page.locator('.wk-eyebrow')).toHaveText('This week');
      await expect(page.locator('.wk-cell--bonus')).toHaveCount(TONES.length);
      const band = await expectWeekMarkContrast(page, `Week, today's band (${theme})`, ['bonus', 'off']);
      expect(band.filter((m) => m.state === 'bonus' && m.on === 'band'), `${theme}: a bonus per tone on the band`).toHaveLength(
        TONES.length,
      );
      expect(band.some((m) => m.state === 'off' && m.on === 'band'), `${theme}: a dash on the band`).toBe(true);
      // Last week: every mark on the paper.
      await page.getByRole('button', { name: 'Previous week' }).click();
      await expect(page.locator('.wk-eyebrow')).toContainText('Last week');
      await expect(page.locator('.wk-cell--bonus')).toHaveCount(TONES.length);
      const paper = await expectWeekMarkContrast(page, `Week, paper (${theme})`, ['bonus', 'off', 'due']);
      expect(paper.every((m) => m.on === 'paper'), `${theme}: no band on a past week`).toBe(true);
      await page.locator('.wk-eyebrow').getByRole('button', { name: 'This week' }).click();
      report[theme] = { band, paper };
    }
    await testInfo.attach('week-mark-contrast.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
    expect(issues).toEqual([]);
  });

  test('Progress heatmaps: done, bonus, missed and pending marks keep 3:1 against the card, in both themes', async ({ page }, testInfo) => {
    const issues = collectConsole(page);
    // One tracker per tone, scheduled every day but today's weekday: today's check-in is a bonus (the round tone ring,
    // polish V4), yesterday's a done fill, the days before are missed hairlines. "Open" is due today and not done
    // (the ember "pending" outline). Same seed whatever the weekday.
    const notToday = EVERY_DAY.filter((d) => d !== TODAY_IDX);
    const habits: SeedHabit[] = [
      ...TONES.map((tone, order) => ({
        id: `heat-${tone}`,
        name: tone.charAt(0).toUpperCase() + tone.slice(1),
        emoji: '⭐',
        color: tone,
        days: notToday,
        createdAt: daysAgo(20),
        order,
      })),
      { id: 'heat-open', name: 'Open', emoji: '⭐', color: 'graphite', days: [...EVERY_DAY], createdAt: daysAgo(20), order: TONES.length },
    ];
    const completions: Record<string, Record<string, true>> = {};
    for (const tone of TONES) completions[`heat-${tone}`] = { [TODAY]: true, [daysAgo(1)]: true };
    const data = JSON.stringify({
      version: 1,
      state: { habits, completions, settings: { theme: 'system', installHintDismissed: true } },
    });
    await page.addInitScript(
      ([key, value]) => {
        if (!localStorage.getItem(key)) localStorage.setItem(key, value);
      },
      [STORAGE_KEY, data] as const,
    );
    await page.goto('/');
    await openTab(page, 'Progress');
    await expect(page.locator('.heat')).toHaveCount(TONES.length + 1);

    /** The weakest ratio per state and tone, for the report. */
    const weakest = (marks: HeatContrast[]): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const m of marks) {
        const key = `${m.state} ${m.tone}`;
        out[key] = Math.min(out[key] ?? Infinity, m.ratio);
      }
      return out;
    };
    const report: Record<string, Record<string, number>> = {};
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const marks = await expectHeatmapMarkContrast(page, `Progress heatmaps (${theme})`, ['done', 'bonus', 'missed', 'pending']);
      expect(marks.filter((m) => m.state === 'bonus').length, `${theme}: a bonus ring per tone`).toBeGreaterThanOrEqual(TONES.length);
      expect(marks.some((m) => m.state === 'pending'), `${theme}: the open tracker's pending outline`).toBe(true);
      report[theme] = weakest(marks);
    }
    await testInfo.attach('heatmap-mark-contrast.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
    expect(issues).toEqual([]);
  });

  test('works offline once the service worker has taken over', async ({ page, context }) => {
    // Resource failures while offline are the point of the test, not app noise.
    const issues = collectConsole(page, /Failed to load resource|Load failed|network connection/i);
    await seedStore(page, TWO_TRACKERS);
    await page.goto('/');
    await expect(page.locator('.habit-row')).toHaveCount(2);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 30_000 });

    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('.view.today')).toBeVisible();
    await expect(page.locator('.habit-row__name')).toHaveText(['Gym', 'Study 2 hours']);
    const fonts = await page.evaluate(async () => {
      await document.fonts.ready;
      return Array.from(document.fonts)
        .filter((f) => f.status === 'loaded')
        .map((f) => f.family.replace(/["']/g, ''));
    });
    expect(fonts, 'self-hosted fonts come from the precache').toContain('Fraunces Variable');
    expect(fonts).toContain('Hanken Grotesk Variable');
    await page.getByRole('button', { name: 'Mark Gym done' }).click();
    await expect(page.locator('.today__ring')).toHaveText('1/2');
    await context.setOffline(false);
    expect(issues).toEqual([]);
  });
});
