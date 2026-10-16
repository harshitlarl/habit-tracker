// Momentum app icon: an ember rounded square carrying a cream brush-stroke check.
// Rasterises public/icons/*.png with sharp and writes public/icons/favicon.svg. Run: npm run icons
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'public', 'icons');

const EMBER = '#D6602F';
const EMBER_LIGHT = '#DC6B3B'; // top of a barely-there gradient that averages to EMBER
const EMBER_DEEP = '#CE5626'; // bottom
const CREAM = '#FBF7EF';
const BOX = 512; // viewBox size
const CORNER = 116; // rounded-square radius (≈ iOS 22.6%)
const SAFE_RADIUS = BOX * 0.4; // maskable safe zone: a centred circle 80% of the icon wide

/** @typedef {[number, number]} Pt */

/* ---------- Brush check: a tapered stroke, built as one filled outline ----------
   Downstroke S → V thickens into the vertex; the flick V → E tapers to a fine tip.
   Both arms are quadratic Béziers with a slight outward bow. */

const S = /** @type {Pt} */ ([122, 276]);
const V = /** @type {Pt} */ ([222, 376]);
const E = /** @type {Pt} */ ([398, 160]);
const H_START = 25; // half-widths
const H_VERTEX = 38;
const H_TIP = 6;
const SAMPLES = 32;

/** @param {number} t */
const smooth = (t) => t * t * (3 - 2 * t);
/** Wraps an angle to (-π, π]. @param {number} a */
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
/** @param {number} n */
const r1 = (n) => String(Math.round(n * 10) / 10);

/**
 * Control point of a quadratic arm: the chord midpoint pushed `bow` px to the stroke's outer side.
 * @param {Pt} a @param {Pt} b @param {number} bow @returns {Pt}
 */
function control(a, b, bow) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  return [(a[0] + b[0]) / 2 - (dy / len) * bow, (a[1] + b[1]) / 2 + (dx / len) * bow];
}

/**
 * Samples a quadratic Bézier arm together with its inner/outer offset points.
 * The check turns left, so the left normal (ty, -tx) faces the inside of the angle.
 * @param {Pt} p0 @param {Pt} c @param {Pt} p1 @param {(t: number) => number} halfWidth
 */
function sampleArm(p0, c, p1, halfWidth) {
  /** @type {{ tx: number; ty: number; inner: Pt; outer: Pt }[]} */
  const out = [];
  for (let i = 0; i <= SAMPLES; i += 1) {
    const t = i / SAMPLES;
    const u = 1 - t;
    const x = u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0];
    const y = u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1];
    const dx = 2 * u * (c[0] - p0[0]) + 2 * t * (p1[0] - c[0]);
    const dy = 2 * u * (c[1] - p0[1]) + 2 * t * (p1[1] - c[1]);
    const len = Math.hypot(dx, dy);
    const tx = dx / len;
    const ty = dy / len;
    const h = halfWidth(t);
    out.push({ tx, ty, inner: [x + ty * h, y - tx * h], outer: [x - ty * h, y + tx * h] });
  }
  return out;
}

/**
 * Interior points of an arc around `c` starting in direction `from` and sweeping `sweep` radians.
 * @param {Pt} c @param {number} r @param {Pt} from @param {number} sweep @param {number} steps
 * @returns {Pt[]}
 */
function arc(c, r, from, sweep, steps) {
  const a0 = Math.atan2(from[1], from[0]);
  /** @type {Pt[]} */
  const pts = [];
  for (let i = 1; i < steps; i += 1) {
    const a = a0 + (sweep * i) / steps;
    pts.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
  }
  return pts;
}

/** Signed short-way sweep from direction `from` to direction `to`. @param {Pt} from @param {Pt} to */
const sweepTo = (from, to) => wrap(Math.atan2(to[1], to[0]) - Math.atan2(from[1], from[0]));

/** A half turn from `from` that passes through the perpendicular direction `through`. @param {Pt} from @param {Pt} through */
const halfTurn = (from, through) => Math.sign(sweepTo(from, through)) * Math.PI;

/** Where the lines (a, da) and (b, db) cross. @param {Pt} a @param {Pt} da @param {Pt} b @param {Pt} db @returns {Pt} */
function intersect(a, da, b, db) {
  const denom = da[0] * db[1] - da[1] * db[0];
  const s = ((b[0] - a[0]) * db[1] - (b[1] - a[1]) * db[0]) / denom;
  return [a[0] + da[0] * s, a[1] + da[1] * s];
}

/** @param {Pt} p @param {Pt} origin @param {Pt} dir */
const along = (p, origin, dir) => (p[0] - origin[0]) * dir[0] + (p[1] - origin[1]) * dir[1];

/** The closed outline of the check, as points in icon space. @returns {Pt[]} */
function checkOutline() {
  const left = sampleArm(S, control(S, V, 14), V, (t) => H_START + (H_VERTEX - H_START) * smooth(t));
  const right = sampleArm(V, control(V, E, 12), E, (t) => H_VERTEX + (H_TIP - H_VERTEX) * t ** 1.5);
  const first = left[0];
  const lastL = left[SAMPLES];
  const firstR = right[0];
  const lastR = right[SAMPLES];
  if (!first || !lastL || !firstR || !lastR) throw new Error('arm sampling produced no points');

  /** @type {Pt[]} */
  const pts = [];

  // Start cap: inner side, around the back, to the outer side.
  const startInner = /** @type {Pt} */ ([first.ty, -first.tx]);
  pts.push(first.inner, ...arc(S, H_START, startInner, halfTurn(startInner, [-first.tx, -first.ty]), 10));

  // Outer edge of the downstroke, a round join under the vertex, then the outer edge of the flick.
  for (const p of left) pts.push(p.outer);
  const outL = /** @type {Pt} */ ([-lastL.ty, lastL.tx]);
  const outR = /** @type {Pt} */ ([-firstR.ty, firstR.tx]);
  pts.push(...arc(V, H_VERTEX, outL, sweepTo(outL, outR), 12));
  for (const p of right) pts.push(p.outer);

  // Tip: outer side, around the front, to the inner side.
  const tipOuter = /** @type {Pt} */ ([-lastR.ty, lastR.tx]);
  pts.push(...arc(E, H_TIP, tipOuter, halfTurn(tipOuter, [lastR.tx, lastR.ty]), 6));

  // Inner edges back to the start; they meet in a crisp mitre at X inside the angle.
  const dirL = /** @type {Pt} */ ([lastL.tx, lastL.ty]);
  const dirR = /** @type {Pt} */ ([firstR.tx, firstR.ty]);
  const X = intersect(lastL.inner, dirL, firstR.inner, dirR);
  for (let i = SAMPLES; i >= 0; i -= 1) {
    const p = right[i];
    if (p && along(p.inner, X, dirR) > 0) pts.push(p.inner);
  }
  pts.push(X);
  for (let i = SAMPLES; i >= 1; i -= 1) {
    const p = left[i];
    if (p && along(p.inner, X, dirL) < 0) pts.push(p.inner);
  }
  return pts;
}

const OUTLINE = checkOutline();
const CHECK = `M${OUTLINE.map(([x, y]) => `${r1(x)} ${r1(y)}`).join('L')}Z`;
const GLYPH_RADIUS = Math.max(...OUTLINE.map(([x, y]) => Math.hypot(x - BOX / 2, y - BOX / 2)));

/**
 * @param {object} o
 * @param {number} o.size     output pixel size (the viewBox is always 512)
 * @param {boolean} o.bleed   full-bleed square (maskable, Apple touch icon) vs rounded square
 * @param {number} [o.glyph]  scale of the check around the centre
 */
function svg({ size, bleed, glyph = 1 }) {
  const shape = bleed
    ? `<rect width="${BOX}" height="${BOX}" fill="url(#ember)"/>`
    : `<rect width="${BOX}" height="${BOX}" rx="${CORNER}" ry="${CORNER}" fill="url(#ember)"/>`;
  const half = BOX / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${BOX} ${BOX}">
  <defs>
    <linearGradient id="ember" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${EMBER_LIGHT}"/>
      <stop offset="1" stop-color="${EMBER_DEEP}"/>
    </linearGradient>
  </defs>
  ${shape}
  <path transform="translate(${half} ${half}) scale(${glyph}) translate(${-half} ${-half})" d="${CHECK}" fill="${CREAM}"/>
</svg>
`;
}

/**
 * @param {string} name
 * @param {number} size
 * @param {{ bleed: boolean; glyph?: number; opaque?: boolean }} style
 */
async function png(name, size, style) {
  const { opaque = false, ...shape } = style;
  const file = resolve(outDir, name);
  let image = sharp(Buffer.from(svg({ size, ...shape })));
  if (opaque) image = image.flatten({ background: EMBER }).removeAlpha();
  await image.png({ compressionLevel: 9 }).toFile(file);

  const meta = await sharp(file).metadata();
  if (meta.width !== size || meta.height !== size) {
    throw new Error(`${name}: expected ${size}×${size}, got ${meta.width}×${meta.height}`);
  }
  console.log(`wrote ${name}  ${meta.width}×${meta.height}  ${meta.hasAlpha ? 'rgba' : 'opaque rgb'}`);
}

await mkdir(outDir, { recursive: true });

if (GLYPH_RADIUS > SAFE_RADIUS) {
  throw new Error(`check glyph reaches ${r1(GLYPH_RADIUS)}px from centre; maskable safe zone is ${SAFE_RADIUS}px`);
}
console.log(`check glyph stays within ${r1(GLYPH_RADIUS)}px of centre (safe zone ${SAFE_RADIUS}px)`);

await png('pwa-192.png', 192, { bleed: false });
await png('pwa-512.png', 512, { bleed: false });
// Maskable: full-bleed, glyph inside the central 80% safe zone (asserted above).
await png('pwa-512-maskable.png', 512, { bleed: true, opaque: true });
// Apple touch icon: opaque, square corners; iOS applies its own corner mask.
await png('apple-touch-icon.png', 180, { bleed: true, opaque: true });

await writeFile(resolve(outDir, 'favicon.svg'), svg({ size: BOX, bleed: false }));
console.log('wrote favicon.svg');
