import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectControlsNamed, expectHitTargets, expectInputFonts } from './helpers/a11y';
import { expectTextContrast, settleAnimations } from './helpers/contrast';

/*
 * One-time tasks (SPEC §14) on an emulated iPhone against the production build: the Tasks section on
 * Today, the day groups on Week and the task editor sheet. Dates are computed here, in the browser's
 * own time zone, so the suite passes on any day of the week. No network.
 *
 * The journey test at the end starts from a fresh profile and walks a week of tasks end to end; the
 * visual test after it checks long text, both themes and 320px. Both save PNGs only when asked to —
 * TASKS_SCREENSHOT_DIR (or SCREENSHOT_DIR, then into its tasks/ folder) — because thirty DPR-3 captures
 * running beside sync.spec.ts pushed its realtime hop past the 10 s budget.
 */

const STORAGE_KEY = 'momentum-v1';
const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const WEEKDAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const pad = (n: number): string => String(n).padStart(2, '0');
const toKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromKey = (k: string): Date => new Date(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10)));
const shift = (d: Date, n: number): Date => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
/** Monday = 0 … Sunday = 6. */
const weekdayOf = (k: string): number => (fromKey(k).getDay() + 6) % 7;
const mondayOf = (k: string): string => toKey(shift(fromKey(k), -weekdayOf(k)));
const dayNumber = (k: string): number => Number(k.slice(8, 10));
/** Calendar days from a to b. */
const diffDays = (a: string, b: string): number => Math.round((fromKey(b).getTime() - fromKey(a).getTime()) / 86_400_000);
/** The editor's last date chip for a date outside the quick row: "Wed 14 Oct" (SPEC §14.7), never a bare weekday. */
const chipDate = (k: string): string => `${WEEKDAY_SHORT[weekdayOf(k)]} ${dayNumber(k)} ${MONTH_SHORT[Number(k.slice(5, 7)) - 1]}`;
/** A quick chip's label (quickDates) for `k` seen from `today`: "Today", "Tomorrow", then "Tue 21". */
const chipLabel = (today: string, k: string): string => {
  const ahead = diffDays(today, k);
  return ahead === 0 ? 'Today' : ahead === 1 ? 'Tomorrow' : `${WEEKDAY_SHORT[weekdayOf(k)]} ${dayNumber(k)}`;
};

const NOW = new Date();
const TODAY = toKey(NOW);
const THREE_DAYS_AGO = toKey(shift(NOW, -3));
/** The next Tuesday strictly after today (1–7 days ahead), like nextWeekdayKey(today, 1). */
const NEXT_TUESDAY = ((): string => {
  const ahead = (1 - weekdayOf(TODAY) + 7) % 7;
  return toKey(shift(NOW, ahead === 0 ? 7 : ahead));
})();

const CARRIED = 'Return the library books';
const TODAY_TASK = 'Renew membership';
const TUESDAY_TASK = 'Meeting with mentor';
const TITLE_PLACEHOLDER = 'e.g. Renew the gym membership';

interface SeedTask {
  id: string;
  title: string;
  date: string;
  time?: string;
  note?: string;
  done: boolean;
  doneAt?: string;
  createdAt: string;
}

type StoredTask = SeedTask;
interface Stored {
  version: number;
  state: { habits: unknown[]; tasks: StoredTask[]; deletedTaskIds: string[] };
}

const CARRIED_TASK: SeedTask = { id: 'carried', title: CARRIED, date: THREE_DAYS_AGO, done: false, createdAt: THREE_DAYS_AGO };

interface SeedExtras {
  /** More trackers after Gym. */
  habits?: unknown[];
  completions?: Record<string, Record<string, true>>;
}

/** A persist-v3 record: one tracker (so Today has its usual layout), any extras, and the given tasks. */
function seedData(tasks: SeedTask[], extras: SeedExtras = {}): string {
  const gym = { id: 'gym', name: 'Gym', emoji: '💪', color: 'terracotta', days: [0, 1, 2, 3, 4, 5, 6], createdAt: THREE_DAYS_AGO, order: 0 };
  return JSON.stringify({
    version: 3,
    state: {
      habits: [gym, ...(extras.habits ?? [])],
      completions: extras.completions ?? {},
      settings: { theme: 'system', installHintDismissed: true },
      deletedIds: [],
      tasks,
      deletedTaskIds: [],
    },
  });
}

async function seed(page: Page, tasks: SeedTask[], extras?: SeedExtras): Promise<void> {
  await page.addInitScript(
    ([key, data]) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, data);
    },
    [STORAGE_KEY, seedData(tasks, extras)] as const,
  );
}

async function readStore(page: Page): Promise<Stored> {
  const raw = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
  if (raw === null) throw new Error('the store was not persisted');
  return JSON.parse(raw) as Stored;
}

/** Console errors + warnings and uncaught exceptions, asserted empty at the end of a test. */
function collectConsole(page: Page): string[] {
  const issues: string[] = [];
  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error' || type === 'warning') issues.push(`[console.${type}] ${msg.text()}`);
  });
  page.on('pageerror', (err) => issues.push(`[pageerror] ${err.message}`));
  return issues;
}

async function openTab(page: Page, label: 'Today' | 'Week' | 'Progress' | 'Trackers'): Promise<void> {
  const tab = page.locator('.tabbar').getByRole('button', { name: label, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-current', 'page');
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
      return (clone.textContent ?? '').trim();
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
      return { w: Math.round(r.width), h: Math.round(r.height), name: el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '' };
    }),
  );
  expect(boxes.length, `${what}: nothing to measure`).toBeGreaterThan(0);
  expect(boxes.filter((b) => b.w < min || b.h < min), `${what}: targets smaller than ${min}px`).toEqual([]);
}

/** Picks `dateKey` in the editor: a quick chip when it is within the week ahead, the native picker otherwise. */
async function pickDate(dialog: Locator, dateKey: string): Promise<void> {
  const ahead = diffDays(TODAY, dateKey);
  if (ahead >= 0 && ahead <= 6) {
    const label = ahead === 0 ? 'Today' : ahead === 1 ? 'Tomorrow' : `${WEEKDAY_SHORT[weekdayOf(dateKey)]} ${dayNumber(dateKey)}`;
    const chip = dialog.getByRole('button', { name: label, exact: true });
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    return;
  }
  await dialog.getByRole('button', { name: 'Pick a date…' }).click();
  const input = dialog.locator('input[type="date"]');
  await expect(input).toBeVisible();
  await input.fill(dateKey);
  await expect(input).toHaveValue(dateKey);
}

/** The pressed chip in the Date fieldset, exactly one. */
async function pressedDateChip(dialog: Locator): Promise<Locator> {
  const pressed = dialog.locator('.task-editor__dates .chip[aria-pressed="true"]');
  await expect(pressed).toHaveCount(1);
  return pressed;
}

/** Walks to the week that contains `dateKey` from the current week with the ‹ › buttons. */
async function goToWeekOf(page: Page, dateKey: string): Promise<void> {
  const pill = page.locator('.wk-eyebrow').getByRole('button', { name: 'This week' });
  if ((await pill.count()) > 0) await pill.click();
  const weeks = Math.round(diffDays(mondayOf(TODAY), mondayOf(dateKey)) / 7);
  for (let i = 0; i < Math.abs(weeks); i += 1) {
    await page.getByRole('button', { name: weeks > 0 ? 'Next week' : 'Previous week' }).click();
  }
  await expect(page.locator('#week-title')).toBeVisible();
}

const tasksSection = (page: Page): Locator => page.locator('section.tasks');
const taskRows = (page: Page): Locator => tasksSection(page).locator('.task-row');
const taskStatus = (page: Page): Locator => tasksSection(page).locator('.tasks__tools span.small-caps');
const checkFor = (scope: Page | Locator, title: string): Locator =>
  scope.getByRole('button', { name: `Mark ${title} done`, exact: true });

/**
 * Escape once the open sheet is listening for it, then waits for it to leave. The Sheet arms its Escape handler in
 * the layout effect that also sets html[data-sheet-open], in the commit that inserts the panel, so the attribute is
 * the signal that it listens (as momentum.spec.ts uses it). It used to be a passive effect a commit later, and a key
 * pressed in that gap was lost; 'Escape pressed the moment a sheet appears still closes it' guards the fix.
 */
async function escapeSheet(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-sheet-open', '');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
}

test.describe('One-time tasks', () => {
  test('Today: a task for today and a timed one for next Tuesday, checked off and edited from the row', async ({ page }) => {
    const issues = collectConsole(page);
    await seed(page, [CARRIED_TASK]);
    await page.goto('/');
    await expect(page.locator('.view.today')).toBeVisible();

    const section = tasksSection(page);
    const dialog = page.getByRole('dialog');
    const addTask = section.getByRole('button', { name: 'Add task' });

    await test.step('the section sits between Due today and the rest, with the carried-over task first', async () => {
      await expect(section.getByRole('heading', { name: 'Tasks' })).toBeVisible();
      await expect(taskStatus(page)).toHaveText('1 left');
      await expect(taskRows(page)).toHaveCount(1);
      await expect(taskRows(page).first().locator('.task-row__title')).toHaveText(CARRIED);
      await expect(taskRows(page).first().locator('.task-row__from')).toHaveText(/^From /);
      // Carried over from three days ago: the label is the weekday name (relativeDayLabel).
      await expect(taskRows(page).first().locator('.task-row__from')).not.toHaveText(/\d/);
      await expectAllButtonsNamed(page, 'Today with tasks');
      await expectTapTargets(section.locator('button'), 44, 'Tasks section controls');
      await expectTextContrast(page, 'Today with tasks (light)');
    });

    await test.step('Close works on an untouched new-task sheet (no error line shifts the panel under the tap)', async () => {
      await addTask.click();
      await expect(dialog.getByRole('heading', { name: 'New task' })).toBeVisible();
      await expect(dialog.getByPlaceholder(TITLE_PLACEHOLDER)).toBeFocused();
      await dialog.getByRole('button', { name: 'Close' }).click();
      await expect(dialog).toHaveCount(0);
    });

    await test.step('an empty title is refused on Save, with an inline error and focus on the field', async () => {
      await addTask.click();
      await expect(dialog.getByRole('heading', { name: 'New task' })).toBeVisible();
      const title = dialog.getByPlaceholder(TITLE_PLACEHOLDER);
      await expect(dialog.locator('.field__error:visible')).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Save task' }).click();
      await expect(dialog.getByText('Give it a title.')).toBeVisible();
      await expect(title).toBeFocused();
      await expect(title).toHaveAttribute('aria-invalid', 'true');
      await expect(dialog).toBeVisible();
    });

    await test.step('saves a task for today (the default chip) and the section counts it', async () => {
      await expect(await pressedDateChip(dialog)).toHaveText('Today');
      await dialog.getByPlaceholder(TITLE_PLACEHOLDER).fill(TODAY_TASK);
      await expect(dialog.getByText('Give it a title.')).toHaveCount(0);
      await expectTapTargets(dialog.locator('.btn, .sheet__close'), 44, 'New task sheet buttons');
      await expectTextContrast(page, 'New task sheet (light)');
      await dialog.getByRole('button', { name: 'Save task' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(taskRows(page).locator('.task-row__title')).toHaveText([CARRIED, TODAY_TASK]);
      await expect(taskStatus(page)).toHaveText('2 left');
      await expect(addTask).toBeFocused(); // focus comes back to the control that opened the sheet
    });

    await test.step('saves a timed task for next Tuesday; it belongs to that day, not to Today', async () => {
      await addTask.click();
      await expect(dialog.getByRole('heading', { name: 'New task' })).toBeVisible();
      await dialog.getByPlaceholder(TITLE_PLACEHOLDER).fill(TUESDAY_TASK);
      await pickDate(dialog, NEXT_TUESDAY);
      await dialog.getByRole('button', { name: 'Add a time' }).click();
      const time = dialog.locator('input[type="time"]');
      await expect(time).toBeVisible();
      await expectTapTargets(dialog.locator('input[type="time"], input[type="date"]'), 44, 'native inputs');
      await time.fill('15:00');
      await expect(time).toHaveValue('15:00');
      await dialog.getByRole('button', { name: 'Save task' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(taskRows(page).locator('.task-row__title')).toHaveText([CARRIED, TODAY_TASK]);

      const stored = await readStore(page);
      expect(stored.version).toBe(3);
      const tuesday = stored.state.tasks.find((t) => t.title === TUESDAY_TASK);
      expect(tuesday?.date).toBe(NEXT_TUESDAY);
      expect(tuesday?.time).toBe('15:00');
      expect(tuesday?.done).toBe(false);
      expect(tuesday).not.toHaveProperty('note');
    });

    await test.step('checking off records doneAt, sinks the row within its group and updates the status', async () => {
      const check = checkFor(section, TODAY_TASK);
      await check.click();
      await expect(check).toHaveAttribute('aria-pressed', 'true');
      await expect(taskRows(page).filter({ hasText: TODAY_TASK })).toHaveClass(/is-done/);
      await expect(taskStatus(page)).toHaveText('1 left');

      // A carried-over task finished today stays listed, checked, so it can still be unchecked.
      const carriedCheck = checkFor(section, CARRIED);
      await carriedCheck.click();
      await expect(carriedCheck).toHaveAttribute('aria-pressed', 'true');
      await expect(taskRows(page).locator('.task-row__title')).toHaveText([CARRIED, TODAY_TASK]);
      await expect(taskStatus(page)).toHaveText('All done');
      await expect(taskStatus(page)).toHaveClass(/accent/);
      const stored = await readStore(page);
      expect(stored.state.tasks.find((t) => t.title === CARRIED)?.doneAt).toBe(TODAY);
      await expectTextContrast(page, 'Today, tasks done (light)');

      await carriedCheck.click();
      await expect(carriedCheck).toHaveAttribute('aria-pressed', 'false');
      await expect(taskStatus(page)).toHaveText('1 left');
      expect((await readStore(page)).state.tasks.find((t) => t.title === CARRIED)).not.toHaveProperty('doneAt');
    });

    await test.step('the row opens the editor prefilled; a note saves into the meta line', async () => {
      const row = taskRows(page).filter({ hasText: TODAY_TASK });
      await row.locator('.task-row__body').click();
      await expect(dialog.getByRole('heading', { name: 'Edit task' })).toBeVisible();
      await expect(dialog.getByPlaceholder(TITLE_PLACEHOLDER)).toHaveValue(TODAY_TASK);
      await expect(await pressedDateChip(dialog)).toHaveText('Today');
      await expect(dialog.getByRole('button', { name: 'Add a time' })).toBeVisible(); // no time yet
      await dialog.getByPlaceholder('Optional, e.g. bring the signed form').fill('bring the signed form');
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(row.locator('.task-row__meta')).toContainText('bring the signed form');
    });

    await test.step('everything survives a reload', async () => {
      await page.reload();
      await expect(page.locator('.view.today')).toBeVisible();
      await expect(taskRows(page).locator('.task-row__title')).toHaveText([CARRIED, TODAY_TASK]);
      await expect(checkFor(tasksSection(page), TODAY_TASK)).toHaveAttribute('aria-pressed', 'true');
      await expect(taskStatus(page)).toHaveText('1 left');
      expect((await readStore(page)).state.tasks).toHaveLength(3);
    });

    await test.step('dark theme keeps the section readable', async () => {
      await page.emulateMedia({ colorScheme: 'dark' });
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expectTextContrast(page, 'Today with tasks (dark)');
    });

    expect(issues, 'console errors/warnings and page errors during the run').toEqual([]);
  });

  test('Week: tasks grouped under their day, Still open on a late one, early check-off, editor from a row', async ({ page }) => {
    const issues = collectConsole(page);
    await seed(page, [
      CARRIED_TASK,
      { id: 'today', title: TODAY_TASK, date: TODAY, done: false, createdAt: TODAY },
      { id: 'tuesday', title: TUESDAY_TASK, date: NEXT_TUESDAY, time: '15:00', note: 'room 4', done: false, createdAt: TODAY },
    ]);
    await page.goto('/');
    await openTab(page, 'Week');
    const weekTasks = page.locator('section.wk-tasks');
    const dialog = page.getByRole('dialog');

    await test.step("today's task sits in today's group, picked out like today's column", async () => {
      await expect(weekTasks.getByRole('heading', { name: 'Tasks this week' })).toBeVisible();
      const todayGroup = weekTasks.locator('.wk-tasks__group.is-today');
      await expect(todayGroup).toHaveCount(1);
      await expect(todayGroup.locator('.wk-tasks__day')).toContainText(`${WEEKDAY_SHORT[weekdayOf(TODAY)]} ${dayNumber(TODAY)}`);
      await expect(todayGroup.locator('.wk-tasks__day')).toContainText('Today');
      await expect(todayGroup.locator('.wk-task__title')).toHaveText([TODAY_TASK]);
      await expect(todayGroup.locator('.wk-task__tag')).toHaveCount(0); // open today, not "Still open"
      await expectAllButtonsNamed(page, 'Week with tasks');
      await expectTapTargets(weekTasks.locator('button'), 44, 'Week tasks controls');
      await expectTextContrast(page, 'Week with tasks (light)');
    });

    await test.step('a timed task shows its clock time in the device locale and can be checked early', async () => {
      await goToWeekOf(page, NEXT_TUESDAY);
      const group = weekTasks.locator('.wk-tasks__group').filter({ hasText: TUESDAY_TASK });
      await expect(group).toHaveCount(1);
      await expect(group.locator('.wk-tasks__day')).toContainText(`Tue ${dayNumber(NEXT_TUESDAY)}`);
      const row = group.locator('.wk-task');
      await expect(row.locator('.wk-task__meta')).toContainText(/3:00\s?PM|15:00/i);
      await expect(row.locator('.wk-task__meta')).toContainText('room 4');
      const check = checkFor(group, TUESDAY_TASK);
      await check.click();
      await expect(check).toHaveAttribute('aria-pressed', 'true');
      await expect(row).toHaveClass(/is-done/);
      expect((await readStore(page)).state.tasks.find((t) => t.id === 'tuesday')?.doneAt).toBe(TODAY);
      await check.click();
      await expect(check).toHaveAttribute('aria-pressed', 'false');
    });

    await test.step('a past, undone task says "Still open" and a late check-off records today', async () => {
      await goToWeekOf(page, THREE_DAYS_AGO);
      const group = weekTasks.locator('.wk-tasks__group').filter({ hasText: CARRIED });
      await expect(group).toHaveCount(1);
      const row = group.locator('.wk-task');
      await expect(row.locator('.wk-task__tag')).toHaveText('Still open');
      await expect(row).toHaveAttribute('data-status', 'overdue');
      const check = checkFor(group, CARRIED);
      await check.click();
      await expect(check).toHaveAttribute('aria-pressed', 'true');
      await expect(row.locator('.wk-task__tag')).toHaveCount(0);
      await expect(row).toHaveAttribute('data-status', 'done');
      const stored = await readStore(page);
      expect(stored.state.tasks.find((t) => t.id === 'carried')).toMatchObject({ done: true, doneAt: TODAY });
      await expectTextContrast(page, 'Week, late task done (light)');
    });

    await test.step('a row opens the editor for that task; Escape closes it and focus returns to the row', async () => {
      const row = weekTasks.locator('.wk-task').filter({ hasText: CARRIED });
      await row.locator('.wk-task__body').click();
      await expect(dialog.getByRole('heading', { name: 'Edit task' })).toBeVisible();
      await expect(dialog.getByPlaceholder(TITLE_PLACEHOLDER)).toHaveValue(CARRIED);
      // Three days back is outside the quick row: the custom chip is selected and names the date in full,
      // "Wed 14 Oct" — not the bare weekday, which beside the quick chip "Wed 21" read as the coming one (QA round 1).
      await expect(await pressedDateChip(dialog)).toHaveText(chipDate(THREE_DAYS_AGO));
      await expect(dialog.locator('input[type="date"]')).toHaveValue(THREE_DAYS_AGO);
      await escapeSheet(page);
      await expect(row.locator('.wk-task__body')).toBeFocused();
    });

    await test.step('a sheet closed right after opening still hands focus back to the row', async () => {
      // The Sheet moves focus into the dialog 20ms after mounting; closing before that must not let the
      // deferred step pull focus into the departing panel (it used to leave focus on <body>).
      const row = weekTasks.locator('.wk-task').filter({ hasText: TODAY_TASK });
      await row.locator('.wk-task__body').click();
      await expect(dialog).toBeVisible();
      // At once, inside the 20ms window. A key that lands before the Sheet has armed its handler is lost (the
      // defect pinned below), so a lost first press is repeated rather than failing this test on it.
      await expect(async () => {
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0, { timeout: 500 });
      }).toPass({ timeout: 5_000 });
      await expect(row.locator('.wk-task__body')).toBeFocused();
    });

    await test.step('"Add task" on a future week proposes that week\'s Monday', async () => {
      await goToWeekOf(page, TODAY);
      await page.getByRole('button', { name: 'Next week' }).click();
      await weekTasks.getByRole('button', { name: 'Add task' }).click();
      await expect(dialog.getByRole('heading', { name: 'New task' })).toBeVisible();
      const nextMonday = toKey(shift(fromKey(mondayOf(TODAY)), 7));
      const ahead = diffDays(TODAY, nextMonday);
      const pressed = await pressedDateChip(dialog);
      if (ahead === 1) await expect(pressed).toHaveText('Tomorrow');
      else if (ahead <= 6) await expect(pressed).toHaveText(`Mon ${dayNumber(nextMonday)}`);
      else await expect(dialog.locator('input[type="date"]')).toHaveValue(nextMonday); // 7 days ahead: outside the quick row
      await dialog.getByPlaceholder(TITLE_PLACEHOLDER).fill('Plan the week');
      await dialog.getByRole('button', { name: 'Save task' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(weekTasks.locator('.wk-task__title').filter({ hasText: 'Plan the week' })).toBeVisible();
      await expect(weekTasks.getByRole('button', { name: 'Add task' })).toBeFocused();
      expect((await readStore(page)).state.tasks.find((t) => t.title === 'Plan the week')?.date).toBe(nextMonday);
    });

    await test.step('dark theme keeps the section readable', async () => {
      await page.emulateMedia({ colorScheme: 'dark' });
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expectTextContrast(page, 'Week with tasks (dark)');
    });

    expect(issues, 'console errors/warnings and page errors during the run').toEqual([]);
  });

  test('deleting a task asks first inside the sheet, tombstones it and moves focus to "Add task"', async ({ page }) => {
    const issues = collectConsole(page);
    await seed(page, [{ id: 'today', title: TODAY_TASK, date: TODAY, done: false, createdAt: TODAY }]);
    await page.goto('/');
    const section = tasksSection(page);
    const dialog = page.getByRole('dialog');

    await taskRows(page).first().locator('.task-row__body').click();
    await expect(dialog.getByRole('heading', { name: 'Edit task' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Delete task' }).click();
    const confirm = dialog.locator('.confirm');
    await expect(confirm).toContainText(`Delete “${TODAY_TASK}”?`);
    await expect(confirm).toContainText('There is no undo.');
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Delete task' })).toBeFocused();

    await dialog.getByRole('button', { name: 'Delete task' }).click();
    await dialog.locator('.confirm').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(taskRows(page)).toHaveCount(0);
    await expect(section.locator('.tasks__empty')).toHaveText('Nothing planned today.');
    await expect(taskStatus(page)).toHaveCount(0); // nothing to count
    await expect(section.getByRole('button', { name: 'Add task' })).toBeFocused();
    const stored = await readStore(page);
    expect(stored.state.tasks).toEqual([]);
    expect(stored.state.deletedTaskIds).toEqual(['today']);

    expect(issues, 'console errors/warnings and page errors during the run').toEqual([]);
  });

  test('task rows read as title, time, note and state to assistive tech, each part apart', async ({ page }) => {
    // QA round 1: the aria-hidden " · " took both its spaces with it, so the row button was named
    // "Mentor meeting 3:00 PMBring the portfolio . Edit task"; HabitRow's "note · Bonus" ran together the same way.
    const issues = collectConsole(page);
    const yesterday = toKey(shift(NOW, -1));
    const tomorrowIdx = (weekdayOf(TODAY) + 1) % 7;
    await seed(
      page,
      [
        { id: 'timed', title: 'Mentor meeting', date: TODAY, time: '15:00', note: 'Bring the portfolio', done: false, createdAt: TODAY },
        { id: 'plain', title: 'Call the bank', date: TODAY, done: false, createdAt: TODAY },
        { id: 'late', title: 'Return the library books', date: yesterday, note: 'two of them', done: false, createdAt: yesterday },
      ],
      {
        // Scheduled only tomorrow and checked today: a bonus row with a note on Today.
        habits: [{ id: 'read', name: 'Read', emoji: '📚', color: 'slate', note: '20 pages', days: [tomorrowIdx], createdAt: THREE_DAYS_AGO, order: 1 }],
        completions: { read: { [TODAY]: true } },
      },
    );
    await page.goto('/');
    const clock = await clockLabel(page, '15:00');
    const onToday = (title: string): Locator => taskRows(page).filter({ hasText: title }).locator('.task-row__body');
    await expect(onToday('Mentor meeting')).toHaveAccessibleName(`Mentor meeting, ${clock}, Bring the portfolio, edit task`);
    await expect(onToday('Call the bank')).toHaveAccessibleName('Call the bank, edit task');
    await expect(onToday('Return the library books')).toHaveAccessibleName(
      'Return the library books, two of them, from Yesterday, edit task',
    );
    // The visible meta line keeps a space on either side of its dot.
    await expect(onToday('Mentor meeting').locator('.task-row__meta')).toHaveText(`${clock} · Bring the portfolio`);
    await expect(onToday('Return the library books').locator('.task-row__meta')).toHaveText('two of them · From Yesterday');

    const toggle = page.locator('.today__toggle');
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    const bonusMeta = page.locator('.habit-row').filter({ hasText: 'Read' }).locator('.habit-row__meta');
    await expect(bonusMeta).toHaveText('20 pages · Bonus');
    const spoken = await bonusMeta.evaluate((el) => {
      const copy = el.cloneNode(true) as HTMLElement;
      for (const hidden of Array.from(copy.querySelectorAll('[aria-hidden="true"]'))) hidden.remove();
      return copy.textContent ?? '';
    });
    expect(spoken, 'what assistive tech reads of the bonus meta line').toMatch(/^20 pages\s+Bonus$/);

    await openTab(page, 'Week');
    const onWeek = (title: string): Locator => page.locator('.wk-task').filter({ hasText: title }).locator('.wk-task__body');
    await expect(onWeek('Mentor meeting')).toHaveAccessibleName(`Mentor meeting, ${clock}, Bring the portfolio, edit task`);
    await goToWeekOf(page, yesterday);
    await expect(onWeek('Return the library books')).toHaveAccessibleName(
      'Return the library books, two of them, still open, edit task',
    );
    expect(issues, 'console errors/warnings and page errors during the run').toEqual([]);
  });

  test('midnight under an open sheet: a new task follows the day, an existing one keeps its date in view', async ({ page }) => {
    // QA round 1: the form fixed its date at mount, so a New task sheet left open across midnight saved to the day
    // before — the task showed up at once as carried over "From Yesterday" — behind a "Yesterday" chip with no field.
    const issues = collectConsole(page);
    const late = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 23, 58, 30); // 90 s of margin before midnight
    const day = toKey(late);
    const next = toKey(shift(late, 1));
    const after = toKey(shift(late, 2));
    await seed(page, [{ id: 'tonight', title: 'Finish the report', date: day, done: false, createdAt: day }]);
    await page.clock.install({ time: late });
    await page.goto('/');
    const dialog = page.getByRole('dialog');
    const section = tasksSection(page);
    const chips = dialog.locator('.task-editor__dates .chip');
    const title = dialog.getByPlaceholder(TITLE_PLACEHOLDER);

    await test.step('a new task typed before midnight and saved after it lands on the new day', async () => {
      await section.getByRole('button', { name: 'Add task' }).click();
      await expect(dialog.getByRole('heading', { name: 'New task' })).toBeVisible();
      await title.fill('Typed before midnight');
      await expect(await pressedDateChip(dialog)).toHaveText('Today');
      await expect(chips.nth(2)).toHaveText(chipLabel(day, toKey(shift(late, 2))));

      await page.clock.runFor(120_000); // past midnight: useToday's timer fires
      await page.evaluate(() => window.dispatchEvent(new Event('focus'))); // as iOS does on resume
      await expect(page.locator('#today-title')).toHaveText(WEEKDAY_LONG[weekdayOf(next)] ?? '');
      await expect(await pressedDateChip(dialog), 'an untouched default still means today').toHaveText('Today');
      await expect(chips.nth(2)).toHaveText(chipLabel(next, toKey(shift(late, 3))));
      await expect(chips.last()).toHaveText('Pick a date…');
      await expect(dialog.locator('input[type="date"]')).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Save task' }).click();
      await expect(dialog).toHaveCount(0);
      expect((await readStore(page)).state.tasks.find((t) => t.title === 'Typed before midnight')?.date).toBe(next);
      await expect(taskRows(page).locator('.task-row__title')).toHaveText(['Finish the report', 'Typed before midnight']);
      await expect(taskRows(page).filter({ hasText: 'Typed before midnight' }).locator('.task-row__from')).toHaveCount(0);
      await expect(taskRows(page).filter({ hasText: 'Finish the report' }).locator('.task-row__from')).toHaveText('From Yesterday');
    });

    await test.step("an existing task's own date stays in view when midnight moves the quick row past it", async () => {
      await page.clock.setSystemTime(new Date(late.getTime() + 86_400_000 + 30_000)); // the next evening, 23:59:00
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await taskRows(page).filter({ hasText: 'Typed before midnight' }).locator('.task-row__body').click();
      await expect(dialog.getByRole('heading', { name: 'Edit task' })).toBeVisible();
      await expect(await pressedDateChip(dialog)).toHaveText('Today');

      await page.clock.setSystemTime(fromKey(after).getTime() + 30_000); // 00:00:30 the day after
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(page.locator('#today-title')).toHaveText(WEEKDAY_LONG[weekdayOf(after)] ?? '');
      const date = dialog.locator('input[type="date"]');
      await expect(date, 'the field appears with the date that will be saved').toBeVisible();
      await expect(date).toHaveValue(next);
      await expect(await pressedDateChip(dialog)).toHaveText(chipDate(next));
      await expect(chips.first()).toHaveText('Today');
      await expect(chips.first()).toHaveAttribute('aria-pressed', 'false');
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      expect((await readStore(page)).state.tasks.find((t) => t.title === 'Typed before midnight')?.date).toBe(next);
      await expect(taskRows(page).filter({ hasText: 'Typed before midnight' }).locator('.task-row__from')).toHaveText('From Yesterday');
    });
    expect(issues, 'console errors/warnings and page errors during the run').toEqual([]);
  });

  test('the editor: Enter saves, a cleared date is refused, Remove drops the time, a double tap saves once', async ({ page }) => {
    const issues = collectConsole(page);
    const tomorrow = toKey(shift(NOW, 1));
    await seed(page, [
      { id: 'timed', title: 'Mentor meeting', date: tomorrow, time: '15:00', note: 'Bring the portfolio', done: false, createdAt: TODAY },
    ]);
    await page.goto('/');
    const section = tasksSection(page);
    const dialog = page.getByRole('dialog');
    const addTask = section.getByRole('button', { name: 'Add task' });
    const title = dialog.getByPlaceholder(TITLE_PLACEHOLDER);
    const titles = async (): Promise<string[]> => (await readStore(page)).state.tasks.map((t) => t.title);

    await test.step('Enter in the title saves a new task', async () => {
      await addTask.click();
      await expect(dialog.getByRole('heading', { name: 'New task' })).toBeVisible();
      await title.fill('Water the plants');
      await title.press('Enter');
      await expect(dialog).toHaveCount(0);
      await expect(taskRows(page).locator('.task-row__title')).toHaveText(['Water the plants']);
      await expect(addTask).toBeFocused();
    });

    await test.step('a cleared date says "Pick a date." and Save moves focus to the field', async () => {
      await addTask.click();
      await title.fill('Waiting for a date');
      await dialog.getByRole('button', { name: 'Pick a date…' }).click();
      const date = dialog.locator('input[type="date"]');
      await expect(date).toBeVisible();
      await expect(date).toHaveValue(TODAY);
      await date.fill('');
      await expect(date).toHaveValue('');
      await dialog.getByRole('button', { name: 'Save task' }).click();
      await expect(dialog.getByText('Pick a date.')).toBeVisible();
      await expect(date).toBeFocused();
      await expect(date).toHaveAttribute('aria-invalid', 'true');
      await expect(dialog.getByRole('heading', { name: 'New task' })).toBeVisible();
      expect(await titles(), 'nothing saved').not.toContain('Waiting for a date');
      // A quick chip puts a date back: the error goes and Save goes through.
      await dialog.getByRole('button', { name: 'Tomorrow', exact: true }).click();
      await expect(dialog.getByText('Pick a date.')).toHaveCount(0);
      await expect(date).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Save task' }).click();
      await expect(dialog).toHaveCount(0);
      expect((await readStore(page)).state.tasks.find((t) => t.title === 'Waiting for a date')?.date).toBe(tomorrow);
    });

    await test.step('Remove drops the time; an emptied note goes too', async () => {
      await openTab(page, 'Week');
      await goToWeekOf(page, tomorrow);
      const row = page.locator('.wk-task').filter({ hasText: 'Mentor meeting' });
      await expect(row.locator('.wk-task__meta')).toContainText('Bring the portfolio');
      await row.locator('.wk-task__body').click();
      await expect(dialog.getByRole('heading', { name: 'Edit task' })).toBeVisible();
      const time = dialog.locator('input[type="time"]');
      await expect(time).toHaveValue('15:00');
      await dialog.getByRole('button', { name: 'Remove time' }).click();
      await expect(time).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: 'Add a time' })).toBeFocused();
      await dialog.getByPlaceholder(NOTE_PLACEHOLDER).fill('');
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(row.locator('.wk-task__meta')).toHaveCount(0);
      await expect(row.locator('.wk-task__body')).toHaveAccessibleName('Mentor meeting, edit task');
      const stored = (await readStore(page)).state.tasks.find((t) => t.id === 'timed');
      expect(stored).not.toHaveProperty('time');
      expect(stored).not.toHaveProperty('note');
    });

    await test.step('a double tap on Save adds the task once', async () => {
      await page.locator('section.wk-tasks').getByRole('button', { name: 'Add task' }).click();
      await expect(dialog.getByRole('heading', { name: 'New task' })).toBeVisible();
      await title.fill('Only once');
      await settleAnimations(page);
      const box = await dialog.getByRole('button', { name: 'Save task' }).boundingBox();
      if (!box) throw new Error('Save task has no box');
      await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
      await expect(dialog).toHaveCount(0);
      expect((await titles()).filter((t) => t === 'Only once')).toHaveLength(1);
      // The second tap landed on the departing sheet, not on whatever lies under it.
      const stored = await readStore(page);
      expect(stored.state.tasks.filter((t) => t.done), 'nothing was checked by the second tap').toEqual([]);
    });
    expect(issues, 'console errors/warnings and page errors during the run').toEqual([]);
  });

  test('importing a backup replaces the tasks: the preview names them, the replaced ones are tombstoned', async ({ page }, testInfo) => {
    const issues = collectConsole(page);
    const tomorrow = toKey(shift(NOW, 1));
    await seed(page, [{ id: 'old-errand', title: 'Old errand', date: TODAY, done: false, createdAt: TODAY }]);
    await page.goto('/');
    await expect(taskRows(page).locator('.task-row__title')).toHaveText(['Old errand']);
    const backup = {
      version: 1,
      habits: [],
      completions: {},
      settings: { theme: 'system', installHintDismissed: true },
      tasks: [
        { id: 'backup-parcel', title: 'Collect the parcel', date: TODAY, time: '18:30', done: false, createdAt: THREE_DAYS_AGO },
        { id: 'backup-dentist', title: 'Book the dentist', date: tomorrow, note: 'a morning slot', done: false, createdAt: THREE_DAYS_AGO },
      ],
      deletedTaskIds: ['long-gone'],
      exportedAt: new Date().toISOString(),
    };
    const file = testInfo.outputPath('tasks-backup.json');
    writeFileSync(file, JSON.stringify(backup));
    await openTab(page, 'Trackers');
    await page.locator('input[type="file"]').setInputFiles(file);
    const confirm = page.locator('.settings .confirm');
    await expect(confirm).toContainText('Replace your data with this backup?');
    await expect(confirm).toContainText('tasks-backup.json holds 0 trackers · 0 check-ins · 2 tasks');
    await expect(confirm).toContainText('1 task on this device will be replaced.');
    await confirm.getByRole('button', { name: 'Replace' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.locator('.settings__status')).toContainText('Imported 0 trackers · 0 check-ins · 2 tasks');

    await openTab(page, 'Today');
    await expect(page.locator('.empty')).toBeVisible(); // the backup holds no trackers
    await expect(taskRows(page).locator('.task-row__title')).toHaveText(['Collect the parcel']);
    await expect(taskRows(page).first().locator('.task-row__meta')).toContainText(await clockLabel(page, '18:30'));
    await expect(taskStatus(page)).toHaveText('1 left');
    const stored = await readStore(page);
    expect(stored.state.tasks.map((t) => t.id).sort()).toEqual(['backup-dentist', 'backup-parcel']);
    expect([...stored.state.deletedTaskIds].sort(), 'the replaced task is tombstoned; the backup\'s tombstones are kept').toEqual([
      'long-gone',
      'old-errand',
    ]);
    await openTab(page, 'Week');
    await goToWeekOf(page, tomorrow);
    await expect(page.locator('.wk-task').filter({ hasText: 'Book the dentist' }).locator('.wk-task__meta')).toHaveText('a morning slot');
    expect(issues, 'console errors/warnings and page errors during the run').toEqual([]);
  });

  test('Escape pressed the moment a sheet appears still closes it', async ({ page }) => {
    // QA round 2: the Sheet used to add its keydown listener in a passive effect a commit after the panel was in the
    // DOM, so an Escape in between was lost and the sheet stayed open (it surfaced as an e2e flake under parallel
    // load). The Sheet now arms it in a layout effect, in the commit that inserts the panel.
    await seed(page, [{ id: 'today', title: TODAY_TASK, date: TODAY, done: false, createdAt: TODAY }]);
    await page.goto('/');
    await expect(taskRows(page)).toHaveCount(1);
    await page.evaluate(() => {
      // Escape in the microtask right after the panel is inserted, as a quick keyboard user (or a loaded test runner) might.
      const observer = new MutationObserver(() => {
        if (!document.querySelector('[role="dialog"]')) return;
        observer.disconnect();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    await taskRows(page).first().locator('.task-row__body').click();
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 2_000 });
  });

  test('a first run shows the quiet empty lines on Today and Week, with the add buttons in place', async ({ page }) => {
    const issues = collectConsole(page);
    await page.goto('/');
    await expect(page.locator('.empty')).toBeVisible(); // no trackers yet
    const section = tasksSection(page);
    await expect(section.locator('.tasks__empty')).toHaveText('Nothing planned today.');
    await expect(section.getByRole('button', { name: 'Add task' })).toBeVisible();

    await openTab(page, 'Week');
    await expect(page.locator('.empty')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Previous week' })).toBeVisible(); // weeks can be planned before the first tracker
    const weekTasks = page.locator('section.wk-tasks');
    await expect(weekTasks.locator('.wk-tasks__none')).toHaveText('No tasks this week.');
    await weekTasks.getByRole('button', { name: 'Add task' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'New task' })).toBeVisible();
    await expect(await pressedDateChip(dialog)).toHaveText('Today');
    await escapeSheet(page);

    expect(issues, 'console errors/warnings and page errors during the run').toEqual([]);
  });
});

/* ---------- the journey and the visual set ---------- */

const SHOTS =
  process.env.TASKS_SCREENSHOT_DIR ??
  path.join(process.env.SCREENSHOT_DIR ?? path.join(process.cwd(), 'e2e', 'screenshots'), 'tasks');
/** PNGs are captured only when a directory was asked for (see the header). */
const CAPTURE = Boolean(process.env.TASKS_SCREENSHOT_DIR || process.env.SCREENSHOT_DIR);
const NOTE_PLACEHOLDER = 'Optional, e.g. bring the signed form';
const TOMORROW = toKey(shift(NOW, 1));
const YESTERDAY = toKey(shift(NOW, -1));

/** The quick chip label of a date 0–6 days ahead (quickDates): "Today", "Tomorrow", then "Tue 21". */
const quickLabel = (k: string): string => {
  const ahead = diffDays(TODAY, k);
  return ahead === 0 ? 'Today' : ahead === 1 ? 'Tomorrow' : `${WEEKDAY_SHORT[weekdayOf(k)]} ${dayNumber(k)}`;
};
/** relativeDayLabel for the near days these tests use. */
const nearLabel = (k: string): string | null => {
  const ahead = diffDays(TODAY, k);
  return ahead === 0 ? 'Today' : ahead === 1 ? 'Tomorrow' : ahead === -1 ? 'Yesterday' : null;
};

/** The app's formatTime(): the device-locale clock, computed in the page with the same Intl call (SPEC §14.10). */
async function clockLabel(page: Page, time: string): Promise<string> {
  return page.evaluate(
    ([h, m]) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(2001, 0, 15, h, m)),
    [Number(time.slice(0, 2)), Number(time.slice(3, 5))] as const,
  );
}

/** Resolves design tokens to computed colours, e.g. { 'ink-2': 'rgb(95, 85, 77)' }. */
async function tokenColors(page: Page, names: readonly string[]): Promise<Record<string, string>> {
  return page.evaluate((list) => {
    const probe = document.createElement('span');
    document.body.appendChild(probe);
    const out: Record<string, string> = {};
    for (const name of list) {
      probe.style.color = `var(--${name})`;
      out[name] = getComputedStyle(probe).color;
    }
    probe.remove();
    return out;
  }, [...names]);
}

async function shotTo(page: Page, name: string, fullPage = false): Promise<void> {
  if (!CAPTURE) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await settleAnimations(page);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), animations: 'disabled', caret: 'hide', fullPage });
}

/** Scrolls the content column so `target` sits near the top of the screen. */
async function scrollToSection(target: Locator): Promise<void> {
  await target.evaluate((el) => {
    const main = el.closest('.app__main');
    if (!main) return;
    const top = el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - 24;
    main.scrollTo({ top: Math.max(0, top) });
  });
}

interface Planned {
  title: string;
  date: string;
  time?: string;
  note?: string;
  done?: boolean;
}

/**
 * The shown week's "Tasks this week" groups match `planned`: one group per day that has tasks,
 * Monday → Sunday, each labelled "Tue 21" (+ "· Tomorrow" when near), its rows in compareTasks order
 * (timed first), with the clock time and note on the meta line and the done state on the row.
 */
async function expectWeekGroups(page: Page, mondayKey: string, planned: readonly Planned[]): Promise<void> {
  const weekTasks = page.locator('section.wk-tasks');
  const inWeek = planned.filter((t) => mondayOf(t.date) === mondayKey);
  const days = [...new Set(inWeek.map((t) => t.date))].sort();
  const groups = weekTasks.locator('.wk-tasks__group');
  if (days.length === 0) {
    await expect(weekTasks.locator('.wk-tasks__none')).toHaveText('No tasks this week.');
    await expect(groups).toHaveCount(0);
    return;
  }
  await expect(groups).toHaveCount(days.length);
  for (const [i, day] of days.entries()) {
    const group = groups.nth(i);
    const labels = group.locator('.wk-tasks__day .small-caps');
    const near = nearLabel(day);
    await expect(labels).toHaveText(near ? [`${WEEKDAY_SHORT[weekdayOf(day)]} ${dayNumber(day)}`, `· ${near}`] : [`${WEEKDAY_SHORT[weekdayOf(day)]} ${dayNumber(day)}`]);
    const rows = inWeek
      .filter((t) => t.date === day)
      .sort((a, b) => (a.time ?? '99:99').localeCompare(b.time ?? '99:99'));
    await expect(group.locator('.wk-task__title')).toHaveText(rows.map((t) => t.title));
    for (const [j, task] of rows.entries()) {
      const row = group.locator('.wk-task').nth(j);
      await expect(row).toHaveAttribute('data-status', task.done ? 'done' : day < TODAY ? 'overdue' : day === TODAY ? 'open' : 'upcoming');
      await expect(checkFor(row, task.title)).toHaveAttribute('aria-pressed', String(Boolean(task.done)));
      if (task.time) await expect(row.locator('.wk-task__meta')).toContainText(await clockLabel(page, task.time));
      if (task.note) await expect(row.locator('.wk-task__meta')).toContainText(task.note);
      if (!task.time && !task.note && !(day < TODAY && !task.done)) await expect(row.locator('.wk-task__meta')).toHaveCount(0);
    }
  }
}

test.describe('One-time tasks — a week of them from a fresh profile', () => {
  test('plan three, check one off, edit it, carry one over, delete one, export, reload, dark', async ({ page }, testInfo) => {
    test.slow();
    const issues = collectConsole(page);
    const dialog = page.getByRole('dialog');
    const section = tasksSection(page);
    const addTask = section.getByRole('button', { name: 'Add task' });
    const weekTasks = page.locator('section.wk-tasks');

    const BANK = 'Call the bank';
    const BANK_RENAMED = 'Call the bank about the new card';
    const RENEW = 'Renew membership';
    const MENTOR = 'Mentor meeting';
    const MENTOR_NOTE = 'Bring the portfolio';
    const MISSED = 'Return the library books';
    const missed: SeedTask = { id: 'missed-yesterday', title: MISSED, date: YESTERDAY, done: false, createdAt: YESTERDAY };
    const controls: Record<string, string[]> = {};

    await test.step('a fresh profile: Today shows the Tasks section with its quiet empty line', async () => {
      await page.goto('/');
      await expect(page.locator('.view.today')).toBeVisible();
      await expect(page.locator('.empty')).toBeVisible(); // no trackers yet; tasks can still be planned
      await expect(section.getByRole('heading', { name: 'Tasks' })).toBeVisible();
      await expect(section.locator('.tasks__empty')).toHaveText('Nothing planned today.');
      await expect(taskStatus(page)).toHaveCount(0);
      await expect(addTask).toBeVisible();
      controls['Today, fresh'] = await expectControlsNamed(page, 'Today, fresh');
      await expectHitTargets(section.locator('button'), 'Tasks section, empty');
      await expectTextContrast(page, 'Today, fresh (light)');
    });

    await test.step(`adds "${BANK}" for today with the default chip`, async () => {
      await addTask.click();
      await expect(dialog.getByRole('heading', { name: 'New task' })).toBeVisible();
      const title = dialog.getByPlaceholder(TITLE_PLACEHOLDER);
      await expect(title).toBeFocused();
      // Today, Tomorrow, the five days after, then "Pick a date…" (quickDates).
      const quick = Array.from({ length: 7 }, (_, i) => quickLabel(toKey(shift(NOW, i))));
      await expect(dialog.locator('.task-editor__dates .chip')).toHaveText([...quick, 'Pick a date…']);
      await expect(await pressedDateChip(dialog)).toHaveText('Today');
      controls['New task sheet'] = await expectControlsNamed(page, 'New task sheet');
      await expectHitTargets(dialog.locator('button, input'), 'New task sheet');
      await expectInputFonts(dialog, 'New task sheet');
      await title.fill(BANK);
      await expect(dialog.locator('.field__count').first()).toHaveText(`${BANK.length}/60`);
      await dialog.getByRole('button', { name: 'Save task' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(taskRows(page).locator('.task-row__title')).toHaveText([BANK]);
      await expect(taskStatus(page)).toHaveText('1 left');
      await expect(addTask).toBeFocused();
    });

    await test.step(`adds "${RENEW}" for next Tuesday with its weekday chip`, async () => {
      await addTask.click();
      await expect(dialog.getByRole('heading', { name: 'New task' })).toBeVisible();
      await dialog.getByPlaceholder(TITLE_PLACEHOLDER).fill(RENEW);
      // The chip reads "Tue 20" (or "Tomorrow" on a Monday); on a Tuesday next week is outside the quick row.
      await pickDate(dialog, NEXT_TUESDAY);
      await dialog.getByRole('button', { name: 'Save task' }).click();
      await expect(dialog).toHaveCount(0);
    });

    await test.step(`adds "${MENTOR}" for tomorrow at 15:00 with a note`, async () => {
      await addTask.click();
      await expect(dialog.getByRole('heading', { name: 'New task' })).toBeVisible();
      await dialog.getByPlaceholder(TITLE_PLACEHOLDER).fill(MENTOR);
      await pickDate(dialog, TOMORROW);
      await dialog.getByRole('button', { name: 'Add a time' }).click();
      const time = dialog.locator('input[type="time"]');
      await expect(time).toBeVisible();
      await expect(time, 'the revealed time field takes focus').toBeFocused();
      await time.fill('15:00');
      await dialog.getByPlaceholder(NOTE_PLACEHOLDER).fill(MENTOR_NOTE);
      controls['New task sheet, timed'] = await expectControlsNamed(page, 'New task sheet, timed');
      await expectHitTargets(dialog.locator('button, input'), 'New task sheet, timed');
      await expectInputFonts(dialog, 'New task sheet, timed');
      await expectTextContrast(page, 'New task sheet, timed (light)');
      await shotTo(page, 'journey-editor-new-timed-light');
      await dialog.getByRole('button', { name: 'Save task' }).click();
      await expect(dialog).toHaveCount(0);
    });

    await test.step("Today lists only today's task: 1 left", async () => {
      await expect(taskRows(page).locator('.task-row__title')).toHaveText([BANK]);
      await expect(taskRows(page).first().locator('.task-row__meta')).toHaveCount(0); // no time, no note
      await expect(taskStatus(page)).toHaveText('1 left');
      const stored = await readStore(page);
      expect(stored.version).toBe(3);
      expect(stored.state.tasks.map((t) => [t.title, t.date, t.time ?? null, t.note ?? null, t.done])).toEqual([
        [BANK, TODAY, null, null, false],
        [RENEW, NEXT_TUESDAY, null, null, false],
        [MENTOR, TOMORROW, '15:00', MENTOR_NOTE, false],
      ]);
      expect(stored.state.tasks.every((t) => t.createdAt === TODAY)).toBe(true);
    });

    await test.step('checking it off: "All done" and a soft strike in the quiet ink', async () => {
      const check = checkFor(section, BANK);
      await check.click();
      await expect(check).toHaveAttribute('aria-pressed', 'true');
      await expect(taskStatus(page)).toHaveText('All done');
      await expect(taskStatus(page)).toHaveClass(/accent/);
      const title = taskRows(page).first().locator('.task-row__title');
      await expect(taskRows(page).first()).toHaveClass(/is-done/);
      const tokens = await tokenColors(page, ['ink-2', 'ink-3']);
      // The title eases into its done colour (200ms transition); toHaveCSS waits for the settled value.
      await expect(title, 'done title in --ink-2 (≥ 4.5:1)').toHaveCSS('color', tokens['ink-2'] ?? '');
      await expect(title, 'the strike in --ink-3').toHaveCSS('text-decoration-color', tokens['ink-3'] ?? '');
      await expect(title).toHaveCSS('text-decoration-line', /line-through/);
      const stored = await readStore(page);
      expect(stored.state.tasks.find((t) => t.title === BANK)).toMatchObject({ done: true, doneAt: TODAY });
      await expectTextContrast(page, 'Today, task done (light)');
    });

    await test.step('opens it from the row, renames it and saves; focus returns to the row', async () => {
      await taskRows(page).first().locator('.task-row__body').click();
      await expect(dialog.getByRole('heading', { name: 'Edit task' })).toBeVisible();
      const title = dialog.getByPlaceholder(TITLE_PLACEHOLDER);
      await expect(title).toHaveValue(BANK);
      await expect(await pressedDateChip(dialog)).toHaveText('Today');
      await expect(dialog.getByRole('button', { name: 'Delete task' })).toBeVisible();
      controls['Edit task sheet'] = await expectControlsNamed(page, 'Edit task sheet');
      await expectHitTargets(dialog.locator('button, input'), 'Edit task sheet');
      await expectInputFonts(dialog, 'Edit task sheet');
      await title.fill(BANK_RENAMED);
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(taskRows(page).locator('.task-row__title')).toHaveText([BANK_RENAMED]);
      await expect(checkFor(section, BANK_RENAMED), 'still done').toHaveAttribute('aria-pressed', 'true');
      await expect(taskRows(page).first().locator('.task-row__body')).toBeFocused();
      await expectTextContrast(page, 'Today with tasks (light)');
      await expectControlsNamed(page, 'Today with tasks');
      await shotTo(page, 'journey-today-light');
    });

    const planned: Planned[] = [
      { title: BANK_RENAMED, date: TODAY, done: true },
      { title: RENEW, date: NEXT_TUESDAY },
      { title: MENTOR, date: TOMORROW, time: '15:00', note: MENTOR_NOTE },
    ];
    const thisMonday = mondayOf(TODAY);
    const nextMonday = toKey(shift(fromKey(thisMonday), 7));

    await test.step("Week: this week's tasks under their days with the clock time; next week's after ›", async () => {
      await openTab(page, 'Week');
      await expect(weekTasks.getByRole('heading', { name: 'Tasks this week' })).toBeVisible();
      await expectWeekGroups(page, thisMonday, planned);
      controls['Week with tasks'] = await expectControlsNamed(page, 'Week with tasks');
      await expectHitTargets(weekTasks.locator('button'), 'Week tasks');
      await expectTextContrast(page, 'Week with tasks (light)');
      await scrollToSection(weekTasks);
      await shotTo(page, 'journey-week-light');

      await page.getByRole('button', { name: 'Next week' }).click();
      await expect(page.locator('.wk-eyebrow')).toContainText('Next week');
      await expectWeekGroups(page, nextMonday, planned);
      await expectTextContrast(page, 'Week, next week (light)');
      await scrollToSection(weekTasks);
      await shotTo(page, 'journey-week-next-light');
      await page.locator('.wk-eyebrow').getByRole('button', { name: 'This week' }).click();
      await expect(page.locator('.wk-eyebrow')).toHaveText('This week');

      // A past week proposes today for a new task (SPEC §14.6), never a day already gone.
      await page.getByRole('button', { name: 'Previous week' }).click();
      await expect(page.locator('.wk-eyebrow')).toContainText('Last week');
      await weekTasks.getByRole('button', { name: 'Add task' }).click();
      await expect(dialog.getByRole('heading', { name: 'New task' })).toBeVisible();
      await expect(await pressedDateChip(dialog)).toHaveText('Today');
      await escapeSheet(page);
      await page.locator('.wk-eyebrow').getByRole('button', { name: 'This week' }).click();
      await expect(page.locator('.wk-eyebrow')).toHaveText('This week');
    });

    await test.step('a missed task (yesterday, never done) is carried to the top of Today', async () => {
      // Written into the persisted record (persist v3, src/lib/store.ts) before the app boots, once.
      await page.addInitScript(
        ([key, task]) => {
          if (sessionStorage.getItem('qa-missed-task') === '1') return;
          sessionStorage.setItem('qa-missed-task', '1');
          const raw = localStorage.getItem(key);
          const data = raw ? (JSON.parse(raw) as { version: number; state: { tasks: unknown[] } }) : null;
          if (!data || data.version !== 3) throw new Error(`expected a persist-v3 record, found ${raw?.slice(0, 40) ?? 'nothing'}`);
          data.state.tasks.push(task);
          localStorage.setItem(key, JSON.stringify(data));
        },
        [STORAGE_KEY, missed] as const,
      );
      await page.reload();
      await expect(page.locator('.view.today')).toBeVisible();
      await expect(taskRows(page).locator('.task-row__title')).toHaveText([MISSED, BANK_RENAMED]);
      const carried = taskRows(page).first();
      // relativeDayLabel: "Yesterday" for the day before, the weekday name up to six days back.
      await expect(carried.locator('.task-row__from')).toHaveText('From Yesterday');
      await expect(checkFor(section, MISSED)).toHaveAttribute('aria-pressed', 'false');
      await expect(taskStatus(page)).toHaveText('1 left');
      await expectTextContrast(page, 'Today with a carried-over task (light)');
    });

    await test.step('checking the late one off keeps it listed; Week shows it on yesterday, done', async () => {
      const check = checkFor(section, MISSED);
      await check.click();
      await expect(check).toHaveAttribute('aria-pressed', 'true');
      await expect(taskRows(page).locator('.task-row__title'), 'nothing moves under the finger').toHaveText([MISSED, BANK_RENAMED]);
      await expect(taskRows(page).first()).toHaveClass(/is-done/);
      await expect(taskStatus(page)).toHaveText('All done');
      const stored = await readStore(page);
      expect(stored.state.tasks.find((t) => t.id === missed.id)).toMatchObject({ date: YESTERDAY, done: true, doneAt: TODAY });
      await shotTo(page, 'journey-today-carried-done-light');

      await openTab(page, 'Week');
      await goToWeekOf(page, YESTERDAY);
      const all = [...planned, { title: MISSED, date: YESTERDAY, done: true }];
      await expectWeekGroups(page, mondayOf(YESTERDAY), all);
      const row = weekTasks.locator('.wk-task').filter({ hasText: MISSED });
      await expect(row.locator('.wk-task__tag'), 'done, so no "Still open"').toHaveCount(0);
    });

    let renewId = '';
    await test.step(`deletes "${RENEW}" through the inline confirm in its editor`, async () => {
      renewId = (await readStore(page)).state.tasks.find((t) => t.title === RENEW)?.id ?? '';
      expect(renewId).not.toBe('');
      await goToWeekOf(page, NEXT_TUESDAY);
      const row = weekTasks.locator('.wk-task').filter({ hasText: RENEW });
      await row.locator('.wk-task__body').click();
      await expect(dialog.getByRole('heading', { name: 'Edit task' })).toBeVisible();
      await dialog.getByRole('button', { name: 'Delete task' }).click();
      const confirm = dialog.locator('.confirm');
      await expect(confirm).toContainText(`Delete “${RENEW}”?`);
      await expect(confirm).toContainText('There is no undo.');
      await expect(dialog.getByRole('button', { name: 'Delete task' })).toHaveCount(0); // the question replaces it
      controls['Delete confirm'] = await expectControlsNamed(page, 'Delete confirm');
      await expectHitTargets(confirm.locator('button'), 'Delete confirm');
      await expectTextContrast(page, 'Edit task, delete confirm (light)');
      await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(weekTasks.locator('.wk-task').filter({ hasText: RENEW })).toHaveCount(0);
      await expect(weekTasks.getByRole('button', { name: 'Add task' }), 'focus lands on "Add task"').toBeFocused();
      const stored = await readStore(page);
      expect(stored.state.tasks.map((t) => t.title).sort()).toEqual([BANK_RENAMED, MENTOR, MISSED].sort());
      expect(stored.state.deletedTaskIds).toEqual([renewId]);
      await page.locator('.wk-eyebrow').getByRole('button', { name: 'This week' }).click();
    });

    await test.step('Export: the backup carries the tasks and the tombstone; the import preview names them', async () => {
      await openTab(page, 'Trackers');
      await page.evaluate(() => {
        const w = window as Window & { __shared?: { name: string; text: string } };
        Object.defineProperty(navigator, 'canShare', { configurable: true, writable: true, value: () => true });
        Object.defineProperty(navigator, 'share', {
          configurable: true,
          writable: true,
          value: async (data: ShareData) => {
            const file = data.files?.[0];
            if (file) w.__shared = { name: file.name, text: await file.text() };
          },
        });
      });
      await page.getByRole('button', { name: 'Export' }).click();
      await expect(page.locator('.settings__status')).toHaveText(`Backup momentum-backup-${TODAY}.json is on its way.`);
      const shared = await page.evaluate(() => (window as Window & { __shared?: { name: string; text: string } }).__shared);
      expect(shared?.name).toBe(`momentum-backup-${TODAY}.json`);
      const backup = JSON.parse(shared?.text ?? 'null') as {
        version: number;
        habits: unknown[];
        tasks?: SeedTask[];
        deletedTaskIds?: string[];
      } | null;
      await testInfo.attach('tasks-backup.json', { body: shared?.text ?? '', contentType: 'application/json' });
      expect(backup?.version).toBe(1);
      expect(backup?.habits).toEqual([]);
      const byTitle = new Map((backup?.tasks ?? []).map((t) => [t.title, t]));
      expect([...byTitle.keys()].sort()).toEqual([BANK_RENAMED, MENTOR, MISSED].sort());
      expect(byTitle.get(BANK_RENAMED)).toMatchObject({ date: TODAY, done: true, doneAt: TODAY, createdAt: TODAY });
      expect(byTitle.get(BANK_RENAMED)).not.toHaveProperty('time');
      expect(byTitle.get(MENTOR)).toMatchObject({ date: TOMORROW, time: '15:00', note: MENTOR_NOTE, done: false });
      expect(byTitle.get(MENTOR)).not.toHaveProperty('doneAt');
      expect(byTitle.get(MISSED)).toEqual({ ...missed, done: true, doneAt: TODAY });
      expect(backup?.deletedTaskIds).toEqual([renewId]);

      // The same file read back: the preview names the tasks, and Cancel leaves everything in place.
      const file = testInfo.outputPath(`momentum-backup-${TODAY}.json`);
      writeFileSync(file, shared?.text ?? '');
      await page.locator('input[type="file"]').setInputFiles(file);
      const confirm = page.locator('.settings .confirm');
      await expect(confirm).toContainText('Replace your data with this backup?');
      await expect(confirm).toContainText('3 tasks');
      await testInfo.attach('import-preview.txt', { body: (await confirm.textContent()) ?? '', contentType: 'text/plain' });
      await confirm.getByRole('button', { name: 'Cancel' }).click();
      await expect(confirm).toHaveCount(0);
    });

    await test.step('a reload keeps everything', async () => {
      await page.reload();
      await expect(page.locator('.view.today')).toBeVisible();
      await expect(taskRows(page).locator('.task-row__title')).toHaveText([MISSED, BANK_RENAMED]);
      await expect(checkFor(section, MISSED)).toHaveAttribute('aria-pressed', 'true');
      await expect(checkFor(section, BANK_RENAMED)).toHaveAttribute('aria-pressed', 'true');
      await expect(taskStatus(page)).toHaveText('All done');
      const stored = await readStore(page);
      expect(stored.version).toBe(3);
      expect(stored.state.tasks).toHaveLength(3);
      expect(stored.state.deletedTaskIds).toEqual([renewId]);
      await openTab(page, 'Week');
      await expectWeekGroups(page, thisMonday, [
        { title: BANK_RENAMED, date: TODAY, done: true },
        { title: MENTOR, date: TOMORROW, time: '15:00', note: MENTOR_NOTE },
        ...(mondayOf(YESTERDAY) === thisMonday ? [{ title: MISSED, date: YESTERDAY, done: true }] : []),
      ]);
    });

    await test.step('dark: Today and Week with tasks stay readable', async () => {
      await page.emulateMedia({ colorScheme: 'dark' });
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expectTextContrast(page, 'Week with tasks (dark)');
      await scrollToSection(weekTasks);
      await shotTo(page, 'journey-week-dark');
      await openTab(page, 'Today');
      await expectTextContrast(page, 'Today with tasks (dark)');
      await shotTo(page, 'journey-today-dark');
      await taskRows(page).first().locator('.task-row__body').click();
      await expect(dialog.getByRole('heading', { name: 'Edit task' })).toBeVisible();
      await expectTextContrast(page, 'Edit task sheet (dark)');
      await shotTo(page, 'journey-editor-edit-dark');
      await escapeSheet(page);
    });

    await testInfo.attach('named-controls.json', { body: JSON.stringify(controls, null, 2), contentType: 'application/json' });
    expect(issues, 'console errors/warnings and page errors during the run').toEqual([]);
  });

  test('captures the tasks visual QA set in light and dark', async ({ page }, testInfo) => {
    test.slow();
    const issues = collectConsole(page);
    const LONG_TITLE = 'Collect the renewed passport and visa papers from the office'; // 60, the maximum
    const LONG_NOTE = 'Bring two photos, the old passport, the receipt and the forms signed at the bank'; // 80
    const ahead5 = toKey(shift(NOW, 5));
    const tasks: SeedTask[] = [
      { id: 'v-carried', title: 'Return the library books', date: THREE_DAYS_AGO, done: false, createdAt: THREE_DAYS_AGO },
      { id: 'v-carried-done', title: 'Post the birthday card', date: toKey(shift(NOW, -2)), done: true, doneAt: TODAY, createdAt: toKey(shift(NOW, -2)) },
      { id: 'v-dentist', title: 'Dentist appointment', date: TODAY, time: '09:30', note: 'Dr. Mehta, bring the X-rays', done: false, createdAt: TODAY },
      { id: 'v-bill', title: 'Pay the electricity bill', date: TODAY, done: true, doneAt: TODAY, createdAt: TODAY },
      { id: 'v-long', title: LONG_TITLE, date: TODAY, note: LONG_NOTE, done: false, createdAt: TODAY },
      { id: 'v-mentor', title: 'Mentor meeting', date: TOMORROW, time: '15:00', note: 'Bring the portfolio', done: false, createdAt: TODAY },
      { id: 'v-renew', title: 'Renew membership', date: NEXT_TUESDAY, done: false, createdAt: TODAY },
      { id: 'v-later', title: 'Book the train to Pune', date: ahead5, time: '19:45', done: false, createdAt: TODAY },
    ];
    await seed(page, tasks);
    await page.goto('/');
    const dialog = page.getByRole('dialog');
    const section = tasksSection(page);
    const weekTasks = page.locator('section.wk-tasks');
    await expect(taskRows(page)).toHaveCount(5); // two carried over, three for today

    // Long text wraps (two title lines at most, then an ellipsis) and never runs past the screen edge.
    const measureRows = async (): Promise<
      Array<{ title: string; lines: number; clamped: boolean; clippedX: number; pastEdge: number }>
    > =>
      taskRows(page).evaluateAll((rows) =>
        rows.map((row) => {
          const title = row.querySelector<HTMLElement>('.task-row__title');
          const body = row.querySelector<HTMLElement>('.task-row__body');
          const lineHeight = title ? Number.parseFloat(getComputedStyle(title).lineHeight) : 1;
          return {
            title: title?.textContent ?? '',
            lines: title ? Math.round(title.getBoundingClientRect().height / lineHeight) : 0,
            clamped: title ? title.scrollHeight > title.clientHeight + 1 : false,
            clippedX: title ? title.scrollWidth - title.clientWidth : 0,
            pastEdge: body ? Math.round(body.getBoundingClientRect().right - window.innerWidth) : 0,
          };
        }),
      );
    const fit390 = await measureRows();
    await testInfo.attach('row-fit-390.json', { body: JSON.stringify(fit390, null, 2), contentType: 'application/json' });
    expect(
      fit390.filter((r) => r.lines > 2 || r.clippedX > 0 || r.pastEdge > 0),
      'rows over two title lines, clipped sideways or past the screen edge',
    ).toEqual([]);

    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await openTab(page, 'Today');
      await scrollToSection(section);
      await shotTo(page, `today-tasks-${theme}`);
      await expectTextContrast(page, `Today, visual set (${theme})`);

      // New task, then the native date field revealed by "Pick a date…".
      await section.getByRole('button', { name: 'Add task' }).click();
      await expect(dialog.getByRole('heading', { name: 'New task' })).toBeVisible();
      await dialog.getByPlaceholder(TITLE_PLACEHOLDER).fill('Pick up the dry cleaning');
      await shotTo(page, `editor-new-${theme}`);
      await dialog.getByRole('button', { name: 'Pick a date…' }).click();
      await expect(dialog.locator('input[type="date"]')).toBeVisible();
      await dialog.getByRole('button', { name: 'Add a time' }).click();
      await expect(dialog.locator('input[type="time"]')).toBeVisible();
      await expectInputFonts(dialog, `New task, native fields (${theme})`);
      await expectHitTargets(dialog.locator('button, input'), `New task, native fields (${theme})`);
      await expectTextContrast(page, `New task, native fields (${theme})`);
      await shotTo(page, `editor-date-picker-${theme}`);
      await escapeSheet(page);

      // Edit a timed task with a note, then its delete question.
      await taskRows(page).filter({ hasText: 'Dentist appointment' }).locator('.task-row__body').click();
      await expect(dialog.getByRole('heading', { name: 'Edit task' })).toBeVisible();
      await expect(dialog.locator('input[type="time"]')).toHaveValue('09:30');
      await shotTo(page, `editor-edit-${theme}`);
      await dialog.getByRole('button', { name: 'Delete task' }).click();
      await expect(dialog.locator('.confirm')).toBeVisible();
      await expectTextContrast(page, `Delete confirm (${theme})`);
      await shotTo(page, `editor-delete-confirm-${theme}`);
      await dialog.locator('.confirm').getByRole('button', { name: 'Cancel' }).click();
      await escapeSheet(page);

      // The longest title and note in the editor, and a past date outside the quick row.
      await taskRows(page).filter({ hasText: LONG_TITLE }).locator('.task-row__body').click();
      await expect(dialog.getByPlaceholder(TITLE_PLACEHOLDER)).toHaveValue(LONG_TITLE);
      await shotTo(page, `editor-edit-long-${theme}`);
      await escapeSheet(page);
      await taskRows(page).filter({ hasText: 'Return the library books' }).locator('.task-row__body').click();
      await expect(dialog.locator('input[type="date"]')).toHaveValue(THREE_DAYS_AGO);
      await shotTo(page, `editor-edit-past-date-${theme}`);
      await escapeSheet(page);

      await openTab(page, 'Week');
      await scrollToSection(weekTasks);
      await shotTo(page, `week-tasks-${theme}`);
      await expectTextContrast(page, `Week, visual set (${theme})`);
      await page.getByRole('button', { name: 'Next week' }).click();
      await expect(page.locator('.wk-eyebrow')).toContainText('Next week');
      await scrollToSection(weekTasks);
      await shotTo(page, `week-tasks-next-${theme}`);
      await page.locator('.wk-eyebrow').getByRole('button', { name: 'This week' }).click();
    }

    // The narrowest phone in use (320 CSS px: a 375pt iPhone SE or Display Zoom): still no sideways scroll.
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 320, height: 700 });
    await openTab(page, 'Today');
    await scrollToSection(section);
    const overflow = await page.evaluate(() => {
      const main = document.querySelector('.app__main');
      return {
        doc: document.documentElement.scrollWidth - window.innerWidth,
        main: main ? main.scrollWidth - main.clientWidth : -1,
      };
    });
    expect(overflow, 'no horizontal scroll at 320px').toEqual({ doc: 0, main: 0 });
    const fit320 = await measureRows();
    await testInfo.attach('row-fit-320.json', { body: JSON.stringify(fit320, null, 2), contentType: 'application/json' });
    expect(
      fit320.filter((r) => r.lines > 2 || r.clippedX > 0 || r.pastEdge > 0),
      '320px: rows over two title lines, clipped sideways or past the screen edge',
    ).toEqual([]);
    await shotTo(page, 'today-tasks-320-light');
    await openTab(page, 'Week');
    await scrollToSection(weekTasks);
    await shotTo(page, 'week-tasks-320-light');

    expect(issues, 'console errors/warnings and page errors during the run').toEqual([]);
  });
});
