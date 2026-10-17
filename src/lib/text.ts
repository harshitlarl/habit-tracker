/**
 * Text capping shared by the store (addTask / updateTask, hydration repair) and the cloud parsers
 * (sync/merge.ts, sync/tasksMerge.ts), so every path that caps a field stores exactly the string the
 * importer (validateAppData) accepts unchanged: trimmed, and at most `max` UTF-16 code units, the unit
 * the editors' maxLength and the importer's length checks count in.
 */

/**
 * `value` trimmed and capped at `max` code units, then trimmed again: the cut can land just after a space
 * (`'a'.repeat(59) + ' b'` capped at 60 keeps the space), which would break the "stored trimmed" rule of
 * titles, names and notes and the export → import round trip. A cut that would split a surrogate pair
 * drops the whole character rather than leave half of it. A value already within the cap comes back as
 * `value.trim()`.
 */
export function clampText(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  if (max <= 0) return '';
  const last = trimmed.charCodeAt(max - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max; // a high surrogate whose low half is cut off
  return trimmed.slice(0, end).trimEnd();
}
