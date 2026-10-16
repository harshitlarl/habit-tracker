import { useEffect, useRef } from 'react';
import { prefersReducedMotion } from '../lib/useReducedMotion';
import './Confetti.css';

export interface ConfettiProps {
  /** Fires one burst on each false → true transition. Keep it true until you want to re-arm. */
  fire: boolean;
  /** Any CSS colours; 'var(--c-sage)' strings are resolved from the document. */
  colors: string[];
  /** ≤ 80 */
  count?: number;
  /** ms */
  duration?: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  rot: number;
  vr: number;
  color: string;
  round: boolean;
}

const MAX_PARTICLES = 80;
const GRAVITY = 1500; // px/s²
const DRAG = 1.1; // 1/s

function resolveColor(color: string): string {
  const m = /^var\((--[\w-]+)\)$/.exec(color.trim());
  if (!m || !m[1]) return color;
  const value = getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim();
  return value || '#D6602F';
}

/**
 * Canvas confetti overlay. Appends a full-screen canvas, animates ~1.2s, removes itself.
 * Respects prefers-reduced-motion (no burst). Never blocks taps (pointer-events: none).
 */
export function Confetti({ fire, colors, count = MAX_PARTICLES, duration = 1200 }: ConfettiProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const prevFire = useRef(false);
  const latest = useRef({ colors, count, duration });
  const active = useRef<{ raf: number; canvas: HTMLCanvasElement } | null>(null);

  useEffect(() => {
    latest.current = { colors, count, duration };
  });

  useEffect(() => {
    const rising = fire && !prevFire.current;
    prevFire.current = fire;
    if (!rising) return;
    const host = hostRef.current;
    if (!host || prefersReducedMotion()) return;

    const canvas = document.createElement('canvas');
    canvas.className = 'confetti__canvas';
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    host.appendChild(canvas);

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = window.innerWidth;
    const H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.scale(dpr, dpr);

    const { colors: rawColors, count: rawCount, duration: total } = latest.current;
    const palette = (rawColors.length > 0 ? rawColors : ['var(--ember)']).map(resolveColor);
    const n = Math.min(MAX_PARTICLES, Math.max(1, Math.floor(rawCount)));
    const particles: Particle[] = Array.from({ length: n }, (_, i) => {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.9;
      const speed = 520 + Math.random() * 460;
      return {
        x: W / 2 + (Math.random() - 0.5) * 80,
        y: H * 0.58,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        w: 6 + Math.random() * 6,
        h: 9 + Math.random() * 8,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 12,
        color: palette[i % palette.length] ?? '#D6602F',
        round: Math.random() < 0.3,
      };
    });

    const start = performance.now();
    let last = start;

    const stop = (): void => {
      if (active.current?.canvas === canvas) active.current = null;
      canvas.remove();
    };

    const tick = (now: number): void => {
      const t = now - start;
      const dt = Math.min(0.034, (now - last) / 1000);
      last = now;
      ctx.clearRect(0, 0, W, H);
      const fade = t > total - 300 ? Math.max(0, (total - t) / 300) : 1;
      for (const p of particles) {
        p.vy += GRAVITY * dt;
        p.vx *= 1 - DRAG * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.vr * dt;
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        if (p.round) {
          ctx.beginPath();
          ctx.ellipse(0, 0, p.w / 2, p.h / 2, 0, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        }
        ctx.restore();
      }
      if (t < total) {
        const raf = requestAnimationFrame(tick);
        if (active.current?.canvas === canvas) active.current.raf = raf;
      } else {
        stop();
      }
    };

    if (active.current) {
      cancelAnimationFrame(active.current.raf);
      active.current.canvas.remove();
    }
    active.current = { raf: requestAnimationFrame(tick), canvas };
  }, [fire]);

  // Unmount: stop any burst in flight.
  useEffect(
    () => () => {
      if (active.current) {
        cancelAnimationFrame(active.current.raf);
        active.current.canvas.remove();
        active.current = null;
      }
    },
    [],
  );

  return <div ref={hostRef} className="confetti" aria-hidden="true" />;
}
