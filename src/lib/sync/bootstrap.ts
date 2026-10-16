/**
 * Wires auth state to the sync engine (SPEC §13.5). Called once from src/main.tsx AFTER the first
 * render. Must never throw and never block rendering: when the env is not configured it only marks the
 * sync store 'off'; otherwise it defers (setTimeout 0), loads Firebase and reacts to auth changes.
 * STUB: body is implemented by the sync-firebase owner; keep the exported name and signature.
 */
export function initSync(): void {
  // stub — intentionally a no-op until implemented
}
