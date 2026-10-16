import { expect, type Page } from '@playwright/test';

/*
 * Colour-contrast checks for the e2e suite (SPEC §12: text ≥ 4.5:1; WCAG 1.4.11: ≥ 3:1 for
 * non-text marks). `auditTextContrast` walks the live DOM so it judges what the user actually
 * sees — resolved tokens, inherited colours, nested translucent surfaces and the Week view's
 * ember band — rather than the stylesheet in the abstract.
 */

export interface ContrastIssue {
  text: string;
  where: string;
  fg: string;
  bg: string;
  ratio: number;
  min: number;
  font: string;
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export const TONES = ['terracotta', 'ochre', 'sage', 'slate', 'plum', 'rose', 'moss', 'graphite'] as const;

export function parseRgb(css: string): Rgba | null {
  const m = /^rgba?\(([^)]+)\)$/.exec(css.trim());
  const inner = m?.[1];
  if (inner === undefined) return null;
  const [r, g, b, a] = inner.split(/[\s,/]+/).filter(Boolean).map(Number);
  if (r === undefined || g === undefined || b === undefined || [r, g, b].some(Number.isNaN)) return null;
  return { r, g, b, a: a === undefined || Number.isNaN(a) ? 1 : a };
}

function luminance(c: Rgba): number {
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG 2.x contrast ratio between two opaque colours. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Waits for running CSS animations/transitions (row rise-ins, sheet slide) so opacities are final. */
export async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const pending = document.getAnimations().map((a) => a.finished.then(() => undefined, () => undefined));
    await Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, 3000))]);
  });
}

/**
 * Every element with its own visible text (plus every input placeholder) whose effective text
 * colour sits under WCAG AA against the first opaque surface behind it. Translucent layers are
 * composited bottom-up, element/ancestor opacity dims the text, and inside the Week grid the
 * absolutely positioned today band counts as the surface for whatever it lies under. Disabled
 * controls are exempt (inactive components are out of scope for 1.4.3); emoji-only runs skip.
 */
export async function auditTextContrast(page: Page): Promise<ContrastIssue[]> {
  await settleAnimations(page);
  return page.evaluate(() => {
    interface C {
      r: number;
      g: number;
      b: number;
      a: number;
    }
    const parse = (css: string): C | null => {
      const m = /^rgba?\(([^)]+)\)$/.exec(css.trim());
      const inner = m?.[1];
      if (inner === undefined) return null;
      const [r, g, b, a] = inner.split(/[\s,/]+/).filter(Boolean).map(Number);
      if (r === undefined || g === undefined || b === undefined || [r, g, b].some(Number.isNaN)) return null;
      return { r, g, b, a: a === undefined || Number.isNaN(a) ? 1 : a };
    };
    const over = (top: C, under: C): C => ({
      r: top.r * top.a + under.r * (1 - top.a),
      g: top.g * top.a + under.g * (1 - top.a),
      b: top.b * top.a + under.b * (1 - top.a),
      a: 1,
    });
    const lin = (v: number): number => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const lum = (c: C): number => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    const ratio = (x: C, y: C): number => {
      const lx = lum(x);
      const ly = lum(y);
      return (Math.max(lx, ly) + 0.05) / (Math.min(lx, ly) + 0.05);
    };
    const hex = (c: C): string =>
      `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
    const one = (e: Element): string => e.tagName.toLowerCase() + Array.from(e.classList).map((c) => `.${c}`).join('');
    const describe = (e: Element): string => (e.parentElement ? `${one(e.parentElement)} > ${one(e)}` : one(e));
    const r2 = (n: number): number => Math.round(n * 100) / 100;

    const bodyBg = parse(getComputedStyle(document.body).backgroundColor) ?? { r: 255, g: 255, b: 255, a: 1 };
    const band = document.querySelector<HTMLElement>('.wk-band');
    const bandRect = band ? band.getBoundingClientRect() : null;
    const bandBg = band ? parse(getComputedStyle(band).backgroundColor) : null;

    /** The opaque surface behind `el`, compositing translucent layers; null when a gradient is in the way. */
    const surfaceBehind = (el: HTMLElement, rect: DOMRect): { bg: C; opacity: number } | null => {
      let opacity = 1;
      const layers: C[] = [];
      let base: C | null = null;
      for (let a: HTMLElement | null = el; a; a = a.parentElement) {
        const s = getComputedStyle(a);
        const o = Number.parseFloat(s.opacity);
        if (!Number.isNaN(o) && o < 1) opacity *= o;
        if (s.backgroundImage !== 'none') return null;
        const c = parse(s.backgroundColor);
        if (c && c.a > 0) {
          if (c.a >= 1) {
            base = c;
            break;
          }
          layers.push(c);
        }
        if (a.classList.contains('wk-grid') && bandRect && bandBg && bandBg.a > 0) {
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          if (cx >= bandRect.left && cx <= bandRect.right && cy >= bandRect.top && cy <= bandRect.bottom) {
            if (bandBg.a >= 1) {
              base = bandBg;
              break;
            }
            layers.push(bandBg);
          }
        }
      }
      let bg = base ?? bodyBg;
      for (let i = layers.length - 1; i >= 0; i -= 1) {
        const layer = layers[i];
        if (layer) bg = over(layer, bg);
      }
      return { bg, opacity };
    };

    const issues: Array<{ text: string; where: string; fg: string; bg: string; ratio: number; min: number; font: string }> = [];

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!(node instanceof HTMLElement)) continue;
      const el = node;
      const text = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? '')
        .join('')
        .trim();
      if (!/[\p{L}\p{N}–—-]/u.test(text)) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) continue; // .sr-only and collapsed boxes
      if (el.closest(':disabled, [aria-disabled="true"]')) continue;
      const fg = parse(cs.color);
      if (!fg) continue;
      const behind = surfaceBehind(el, rect);
      if (!behind) continue;
      const fgEff = over({ ...fg, a: fg.a * behind.opacity }, behind.bg);
      const size = Number.parseFloat(cs.fontSize);
      const weight = Number.parseInt(cs.fontWeight, 10) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const min = large ? 3 : 4.5;
      const r = ratio(fgEff, behind.bg);
      if (r < min) {
        issues.push({
          text: text.slice(0, 40),
          where: describe(el),
          fg: hex(fgEff),
          bg: hex(behind.bg),
          ratio: r2(r),
          min,
          font: `${size}px/${weight}`,
        });
      }
    }

    // Placeholder text is text too. WebKit exposes the pseudo-element's computed style.
    for (const input of Array.from(document.querySelectorAll<HTMLInputElement>('input[placeholder]'))) {
      if (input.disabled) continue;
      const rect = input.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) continue;
      const ps = getComputedStyle(input, '::placeholder');
      const fg = parse(ps.color);
      const behind = surfaceBehind(input, rect);
      if (!fg || !behind) continue;
      const o = Number.parseFloat(ps.opacity);
      const fgEff = over({ ...fg, a: fg.a * (Number.isNaN(o) ? 1 : o) * behind.opacity }, behind.bg);
      const r = ratio(fgEff, behind.bg);
      if (r < 4.5) {
        issues.push({
          text: input.placeholder.slice(0, 40),
          where: `${describe(input)}::placeholder`,
          fg: hex(fgEff),
          bg: hex(behind.bg),
          ratio: r2(r),
          min: 4.5,
          font: `${ps.fontSize}/${ps.fontWeight}`,
        });
      }
    }
    return issues;
  });
}

/**
 * Soft assertion: records any text under WCAG AA on the current screen and lets the journey
 * continue, so one low-contrast label does not hide everything after it.
 */
export async function expectTextContrast(page: Page, where: string): Promise<ContrastIssue[]> {
  const issues = await auditTextContrast(page);
  expect.soft(issues, `${where}: text under WCAG AA (4.5:1, or 3:1 for large text)`).toEqual([]);
  return issues;
}

export interface ToneContrast {
  tone: (typeof TONES)[number];
  fill: string;
  onBg: number;
  onSurface: number;
  /** The --surface checkmark drawn on the filled mark. */
  strokeOnFill: number;
}

/** Resolves the eight habit colours and measures them against the paper and the check stroke. */
export async function measureToneContrast(page: Page): Promise<ToneContrast[]> {
  const resolved = await page.evaluate((tones) => {
    const probe = document.createElement('span');
    document.body.appendChild(probe);
    const resolve = (value: string): string => {
      probe.style.color = value;
      return getComputedStyle(probe).color;
    };
    const out: Record<string, string> = {};
    for (const name of ['bg', 'surface', ...tones.map((t) => `c-${t}`)]) out[name] = resolve(`var(--${name})`);
    probe.remove();
    return out;
  }, [...TONES]);
  const bg = parseRgb(resolved['bg'] ?? '');
  const surface = parseRgb(resolved['surface'] ?? '');
  if (!bg || !surface) throw new Error(`--bg / --surface did not resolve: ${JSON.stringify(resolved)}`);
  return TONES.map((tone) => {
    const fillCss = resolved[`c-${tone}`] ?? '';
    const fill = parseRgb(fillCss);
    if (!fill) throw new Error(`--c-${tone} did not resolve: ${fillCss}`);
    return {
      tone,
      fill: fillCss,
      onBg: round2(contrastRatio(fill, bg)),
      onSurface: round2(contrastRatio(fill, surface)),
      strokeOnFill: round2(contrastRatio(surface, fill)),
    };
  });
}

/** Every filled "done" mark and the check drawn on it read at ≥ 3:1 (WCAG 1.4.11) in the current theme. */
export async function expectToneContrast(page: Page, theme: 'light' | 'dark'): Promise<ToneContrast[]> {
  const table = await measureToneContrast(page);
  expect(table, `${theme}: all eight habit colours resolve`).toHaveLength(TONES.length);
  expect(
    table.filter((row) => row.onBg < 3 || row.strokeOnFill < 3),
    `${theme}: habit colours under 3:1 against the paper or under their check stroke`,
  ).toEqual([]);
  return table;
}
