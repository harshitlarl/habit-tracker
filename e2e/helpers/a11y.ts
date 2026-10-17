import { expect, type Locator, type Page } from '@playwright/test';

/*
 * Accessibility checks shared by the specs (SPEC §12: every control has a label; tap targets ≥ 44px;
 * inputs ≥ 16px so iOS does not zoom). Names come from Playwright's own accessibility tree (the same
 * computation getByRole uses), not from a hand-rolled reading of aria-label and text.
 */

/** Roles a person operates. An entry for one of these without a quoted name in the snapshot has no name. */
const CONTROL_ROLES = [
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'tab',
  'menuitem',
  'option',
] as const;

const UNNAMED = new RegExp(`^\\s*- (${CONTROL_ROLES.join('|')})(?=$| \\[|:)`);
const NAMED = new RegExp(`^\\s*- (${CONTROL_ROLES.join('|')}) "`);

/**
 * Every control in the accessibility tree of the page (hidden and aria-hidden content excluded, as
 * assistive tech sees it) has a non-empty accessible name. Returns the named controls' snapshot
 * lines, handy as an attachment.
 */
export async function expectControlsNamed(page: Page, where: string): Promise<string[]> {
  const lines = (await page.locator('body').ariaSnapshot()).split('\n');
  expect(
    lines.filter((line) => UNNAMED.test(line)),
    `${where}: controls without an accessible name`,
  ).toEqual([]);
  const named = lines.filter((line) => NAMED.test(line)).map((line) => line.trim());
  expect(named.length, `${where}: controls found`).toBeGreaterThan(0);
  return named;
}

/**
 * Every matched element can be hit on a `min` × `min` area through its centre. A box smaller than that
 * passes only when points at the edges of a `min` square around its centre still land on it — the
 * way a Chip's ::before (inset −4px) turns a 36px pill into a 44px target. Each element is scrolled
 * into view first, so nothing off screen is probed.
 */
export async function expectHitTargets(locator: Locator, what: string, min = 44): Promise<void> {
  const count = await locator.count();
  expect(count, `${what}: nothing to measure`).toBeGreaterThan(0);
  const small: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const el = locator.nth(i);
    if (!(await el.isVisible())) continue;
    await el.scrollIntoViewIfNeeded();
    const result = await el.evaluate((node, size) => {
      const r = node.getBoundingClientRect();
      const label = (node.getAttribute('aria-label') ?? node.textContent ?? '').trim().slice(0, 40);
      const hits = (x: number, y: number): boolean => {
        const at = document.elementFromPoint(x, y);
        return at !== null && (at === node || node.contains(at));
      };
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const half = size / 2 - 0.5;
      const wide = r.width >= size || (hits(cx - half, cy) && hits(cx + half, cy));
      const tall = r.height >= size || (hits(cx, cy - half) && hits(cx, cy + half));
      return { ok: wide && tall, desc: `${node.tagName.toLowerCase()} "${label}" ${Math.round(r.width)}×${Math.round(r.height)}` };
    }, min);
    if (!result.ok) small.push(result.desc);
  }
  expect(small, `${what}: hit targets under ${min}px`).toEqual([]);
}

/** Every visible text-like input, select and textarea inside `scope` is set at ≥ `min` px. */
export async function expectInputFonts(scope: Locator, what: string, min = 16): Promise<void> {
  const fields = await scope.locator('input:visible, textarea:visible, select:visible').evaluateAll((els) =>
    els
      .filter((el) => !(el instanceof HTMLInputElement) || !['checkbox', 'radio', 'file', 'hidden'].includes(el.type))
      .map((el) => ({
        field: `${el.tagName.toLowerCase()}[type=${el.getAttribute('type') ?? ''}] ${el.getAttribute('placeholder') ?? el.id}`,
        size: Number.parseFloat(getComputedStyle(el).fontSize),
      })),
  );
  expect(fields.length, `${what}: fields to measure`).toBeGreaterThan(0);
  expect(
    fields.filter((f) => f.size < min),
    `${what}: inputs under ${min}px`,
  ).toEqual([]);
}
