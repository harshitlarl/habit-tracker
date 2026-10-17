/*
 * A one-component stand-in for React's useState / useEffect, so the clock hooks (useToday, useHour) can
 * be tested in Node without a DOM: calling the hook is a render, mountHook() runs its effect the way
 * React runs a passive effect (a moment after the render), and its cleanup is the unmount. Plus a
 * minimal event target for the document / window events the hooks listen to. A test file installs it
 * with `vi.mock('react', async () => (await import('./fakeReact')).fakeReact)`. Not a test file itself.
 */

type Effect = () => void | (() => void);

const slot: { initialised: boolean; value: unknown; effect: Effect | null } = {
  initialised: false,
  value: undefined,
  effect: null,
};

export const fakeReact = {
  useState<S>(init: () => S): [S, (next: (prev: S) => S) => void] {
    if (!slot.initialised) {
      slot.value = init();
      slot.initialised = true;
    }
    const setState = (next: (prev: S) => S): void => {
      slot.value = next(slot.value as S);
    };
    return [slot.value as S, setState];
  },
  /** The hooks under test pass `[]` deps: only the first render's effect is kept. */
  useEffect(effect: Effect): void {
    slot.effect ??= effect;
  },
};

/** Forget the previous component, so the next call of the hook is a first render. */
export function resetHook(): void {
  slot.initialised = false;
  slot.value = undefined;
  slot.effect = null;
}

/** The hook's current state. */
export function hookValue(): unknown {
  return slot.value;
}

/** Run the effect of the first render; returns its cleanup (the unmount). */
export function mountHook(): () => void {
  const cleanup = slot.effect?.();
  return typeof cleanup === 'function' ? cleanup : () => {};
}

export interface FakeTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  /** Call every listener of `type`, as the browser would on that event. */
  dispatch(type: string): void;
  /** Listeners still attached, all types together. */
  listenerCount(): number;
}

/** `props` plus add/removeEventListener, for stubbing `document` or `window`. */
export function fakeTarget<T extends object>(props: T): T & FakeTarget {
  const listeners = new Map<string, Set<() => void>>();
  const target: FakeTarget = {
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener();
    },
    listenerCount() {
      let count = 0;
      for (const set of listeners.values()) count += set.size;
      return count;
    },
  };
  return Object.assign(props, target);
}
