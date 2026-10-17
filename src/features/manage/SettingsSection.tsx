import { useId, useRef, useState, type ChangeEvent, type Ref } from 'react';
import { format } from 'date-fns';
import useStore, { useStorageHealth, validateAppData } from '../../lib/store';
import type { AppData, Theme } from '../../lib/types';
import { todayKey } from '../../lib/dates';
import { totalCompletions } from '../../lib/streaks';
import { isIOS, isStandalone } from '../../lib/platform';
import { isSyncConfigured } from '../../lib/sync/firebase';
import { useSyncStore } from '../../lib/sync/syncStore';
import { signOutUser } from '../../lib/sync/auth';
import { stopSync } from '../../lib/sync/engine';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { SegmentedControl } from '../../components/SegmentedControl';
import { cx } from '../../components/cx';
import { InlineConfirm } from './InlineConfirm';
import { SyncSection } from './SyncSection';
import { errorMessage } from './syncText';
import './SettingsSection.css';

const THEME_OPTIONS: ReadonlyArray<{ value: Theme; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const isTheme = (value: string): value is Theme => THEME_OPTIONS.some((o) => o.value === value);

interface Status {
  tone: 'ok' | 'error';
  text: string;
}

interface PendingImport {
  fileName: string;
  data: AppData;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "a and b" / "a, b and c" (two or more parts). */
const listOf = (parts: readonly string[]): string =>
  parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] ?? ''}`;

/**
 * Signed in, an import is not a local affair: the trackers it replaces are tombstoned, tombstones sync
 * to every device and always win, and the backup's check-ins replace the account's. Say so plainly.
 */
const IMPORT_SIGNED_IN =
  'Trackers and tasks not in this backup are deleted from your account and every signed-in device, and check-ins made since it was exported are removed. There is no undo.';

const NOT_SAVING = 'This device is not saving changes right now — export a backup.';

interface ResetCopy {
  title: string;
  body: string;
  confirmLabel: string;
}

/**
 * The reset confirmation. The button, the question and the confirm all say "reset". Signed in, it
 * promises the account holds everything only when that is known (`accountCurrent`); offline, still
 * connecting or in error, unsynced check-ins would die with the device copy, so the copy warns instead.
 */
function describeReset(signedIn: boolean, accountCurrent: boolean): ResetCopy {
  if (!signedIn) {
    return {
      title: 'Reset this device?',
      body: 'Every tracker, check-in and task on this device will be removed and the theme goes back to System. Export a backup first if you might want it back.',
      confirmLabel: 'Reset',
    };
  }
  if (accountCurrent) {
    return {
      title: 'Reset this device?',
      body: "You'll be signed out first, so your trackers and tasks stay safe in your account. Then every tracker, check-in and task on this device will be removed and the theme goes back to System. Sign in again any time to bring it all back.",
      confirmLabel: 'Sign out and reset',
    };
  }
  return {
    title: 'Reset this device?',
    body: "Some changes here may not have reached your account yet — check the status above, or reset anyway and lose them. You'll be signed out first, then every tracker, check-in and task on this device is removed and the theme goes back to System.",
    confirmLabel: 'Reset anyway',
  };
}

/**
 * "1 tracker · 42 check-ins · 3 tasks · exported 16 Oct 2026". Tasks are named only when the backup
 * holds some: a pre-phase-3 file has no `tasks` key, and a file with none reads as it always did.
 */
function describeBackup(data: AppData): string {
  const parts = [plural(data.habits.length, 'tracker'), plural(totalCompletions(data.completions), 'check-in')];
  const taskCount = data.tasks?.length ?? 0;
  if (taskCount > 0) parts.push(plural(taskCount, 'task'));
  if (data.exportedAt) {
    const exported = new Date(data.exportedAt);
    if (!Number.isNaN(exported.getTime())) parts.push(`exported ${format(exported, 'd MMM yyyy')}`);
  }
  return parts.join(' · ');
}

/** Classic download through a temporary anchor. */
function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export interface SettingsSectionProps {
  /** The "Settings" heading (focusable, tabIndex -1): the Trackers header's gear scrolls to it. */
  titleRef?: Ref<HTMLHeadingElement>;
}

/**
 * Settings, in this order: Appearance → Your data → Sync across devices → Install on iPhone →
 * Reset this device, then the about line. A first-time user meets the local-first basics before any
 * account form, and the one destructive action comes last.
 */
export function SettingsSection({ titleRef }: SettingsSectionProps) {
  const theme = useStore((s) => s.settings.theme);
  const setTheme = useStore((s) => s.setTheme);
  const exportData = useStore((s) => s.exportData);
  const importData = useStore((s) => s.importData);
  const resetAll = useStore((s) => s.resetAll);
  const habitCount = useStore((s) => s.habits.length);
  const completionCount = useStore((s) => totalCompletions(s.completions));
  const taskCount = useStore((s) => s.tasks.length);
  const installHintDismissed = useStore((s) => s.settings.installHintDismissed);
  const notSaving = useStorageHealth((s) => s.error !== null || s.unavailable);
  const signedIn = useSyncStore((s) => s.user !== null);
  const booting = useSyncStore((s) => s.booting);
  const syncStatus = useSyncStore((s) => s.status);
  const syncPending = useSyncStore((s) => s.pending);

  /** Outcome of the latest export or import, shown in the "Your data" card. */
  const [status, setStatus] = useState<Status | null>(null);
  /** Outcome of a reset (or of a sign-out that kept it from happening), shown in the Reset card. */
  const [resetStatus, setResetStatus] = useState<Status | null>(null);
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [standalone] = useState(isStandalone);
  const [ios] = useState(isIOS);
  const [syncAvailable] = useState(isSyncConfigured);
  const fileRef = useRef<HTMLInputElement>(null);
  const resetRef = useRef<HTMLButtonElement>(null);
  const resetHintId = useId();

  function onExport(): void {
    const fileName = `momentum-backup-${todayKey()}.json`;
    const blob = new Blob([JSON.stringify(exportData(), null, 2)], { type: 'application/json' });
    setPending(null);
    setResetStatus(null);

    // Home Screen web apps on iOS cannot reliably download a file; the share sheet offers
    // "Save to Files" and works in both Safari and standalone mode.
    if (isIOS() && typeof navigator.share === 'function' && typeof navigator.canShare === 'function') {
      const file = new File([blob], fileName, { type: 'application/json' });
      if (navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: 'Momentum backup' }).then(
          () => setStatus({ tone: 'ok', text: `Backup ${fileName} is on its way.` }),
          (error: unknown) => {
            if (error instanceof DOMException && error.name === 'AbortError') return;
            downloadBlob(blob, fileName);
            setStatus({ tone: 'ok', text: `Saved ${fileName}.` });
          },
        );
        return;
      }
    }

    downloadBlob(blob, fileName);
    setStatus({ tone: 'ok', text: `Saved ${fileName}.` });
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setPending(null);
    setResetStatus(null);

    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setStatus({ tone: 'error', text: `${file.name} is not readable JSON.` });
      return;
    }

    const result = validateAppData(parsed);
    if (!result.ok) {
      setStatus({ tone: 'error', text: `Could not import ${file.name}: ${result.error}` });
      return;
    }
    setStatus(null);
    setPending({ fileName: file.name, data: result.data });
  }

  function confirmImport(): void {
    if (!pending) return;
    const result = importData(pending.data);
    setPending(null);
    setStatus(
      result.ok
        ? { tone: 'ok', text: `Imported ${describeBackup(pending.data)}.` }
        : { tone: 'error', text: `Could not import ${pending.fileName}: ${result.error}` },
    );
  }

  function cancelImport(): void {
    setPending(null);
    setStatus(null);
  }

  function cancelReset(): void {
    setConfirmReset(false);
    // The Reset button mounts again on this render; focus it once it exists.
    requestAnimationFrame(() => resetRef.current?.focus());
  }

  /**
   * "Reset this device" is local only. Signed in, it signs out first so the wipe never reaches
   * the account (SPEC §13.4); if that fails nothing is touched. The engine is detached explicitly
   * before the wipe rather than trusting the auth callback to have run first. The button stays
   * disabled while Firebase is still restoring a saved session: a wipe then would run as signed
   * out, and the restored session's first-contact merge would pull the whole cloud copy back.
   */
  async function doReset(): Promise<void> {
    const wasSignedIn = useSyncStore.getState().user !== null;
    if (wasSignedIn) {
      setResetting(true);
      try {
        await signOutUser();
        stopSync();
      } catch (error) {
        setResetting(false);
        cancelReset();
        setResetStatus({
          tone: 'error',
          text: `Could not sign out, so nothing was reset. ${errorMessage(error, 'Try again in a moment.')}`,
        });
        return;
      }
      setResetting(false);
    }
    resetAll();
    setConfirmReset(false);
    setPending(null);
    setStatus(null);
    setResetStatus({
      tone: 'ok',
      text: wasSignedIn ? 'Signed out. Everything on this device has been cleared.' : 'Everything has been cleared.',
    });
  }

  const hasData = habitCount > 0 || completionCount > 0 || taskCount > 0;
  // "The 2 trackers, 5 check-ins and 3 tasks on this device" — tasks named only when there are some,
  // since an import replaces them too (a backup without tasks leaves none).
  const onDevice = [plural(habitCount, 'tracker'), plural(completionCount, 'check-in')];
  if (taskCount > 0) onDevice.push(plural(taskCount, 'task'));
  // The account is known to hold everything only once the last snapshot came from the server with
  // no write still waiting. Offline, connecting or in error, a reset could lose unsynced check-ins.
  const resetCopy = describeReset(signedIn, syncStatus === 'synced' && !syncPending);
  // One install prompt at a time: in iOS Safari the bottom banner (InstallHint) says it until dismissed.
  const installBannerShowing = ios && !standalone && !installHintDismissed;
  const showInstallCard = !standalone && !installBannerShowing;
  // A fresh Home Screen copy starts empty (its own storage, apart from Safari's): point at the way back.
  const movingOver = standalone && !signedIn && !booting && habitCount === 0 && taskCount === 0;

  return (
    <section className="settings" aria-labelledby="settings-title">
      <h2 id="settings-title" ref={titleRef} tabIndex={-1} className="display display--lg settings__title">
        Settings
      </h2>

      <div className="card settings__group">
        <p className="small-caps settings__label">Appearance</p>
        <SegmentedControl
          label="Theme"
          value={theme}
          onChange={(value) => {
            if (isTheme(value)) setTheme(value);
          }}
          options={THEME_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        />
      </div>

      <div className="card settings__group">
        <p className="small-caps settings__label">Your data</p>
        <p className="settings__body">
          {signedIn
            ? 'Your trackers and tasks live on this device and sync to your account. A backup file is still worth keeping now and then.'
            : 'Everything is stored on this device only. Export a backup now and then, and import it to pick up on a new phone.'}
        </p>
        <p className="settings__warning" role="status">
          {notSaving ? NOT_SAVING : null}
        </p>
        {movingOver ? (
          <p className="settings__note">
            {syncAvailable
              ? 'Moving over from Safari? Import your backup or sign in.'
              : 'Moving over from Safari? Import your backup.'}
          </p>
        ) : null}
        <div className="settings__buttons">
          <Button variant="subtle" icon={<Icon name="download" size={20} />} onClick={onExport}>
            Export
          </Button>
          <Button variant="subtle" icon={<Icon name="upload" size={20} />} onClick={() => fileRef.current?.click()}>
            Import
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => void onFile(e)}
          />
        </div>

        {pending ? (
          <InlineConfirm
            title="Replace your data with this backup?"
            body={
              <>
                {pending.fileName} holds {describeBackup(pending.data)}.{' '}
                {signedIn
                  ? IMPORT_SIGNED_IN
                  : hasData
                    ? `The ${listOf(onDevice)} on this device will be replaced.`
                    : 'Nothing on this device will be lost.'}
              </>
            }
            confirmLabel="Replace"
            tone="primary"
            onConfirm={confirmImport}
            onCancel={cancelImport}
          />
        ) : null}

        <p className={cx('settings__status', status?.tone === 'error' && 'is-error')} role="status">
          {status ? status.text : null}
        </p>
      </div>

      <SyncSection />

      {showInstallCard ? (
        <div className="card settings__group settings__install">
          <span className="settings__install-icon" aria-hidden="true">
            <Icon name="share" size={24} />
          </span>
          <div className="settings__install-text">
            <h3 className="display display--md">Install on iPhone</h3>
            <p className="settings__body">
              Open in Safari → tap Share → Add to Home Screen. Momentum then opens full screen from your Home Screen
              and works offline.{' '}
              The installed app starts with its own empty copy: export a backup here first, then import it there
              {syncAvailable ? ' (or sign in on both)' : ''}.
            </p>
          </div>
        </div>
      ) : null}

      <div className="card settings__group settings__reset">
        <div className="settings__danger">
          {confirmReset ? (
            <InlineConfirm
              title={resetCopy.title}
              body={resetCopy.body}
              confirmLabel={resetCopy.confirmLabel}
              busy={resetting}
              busyLabel="Signing out…"
              onConfirm={() => void doReset()}
              onCancel={cancelReset}
            />
          ) : (
            <>
              <Button
                ref={resetRef}
                variant="danger"
                icon={<Icon name="trash" size={20} />}
                onClick={() => setConfirmReset(true)}
                disabled={booting}
                aria-describedby={booting ? resetHintId : undefined}
              >
                Reset this device
              </Button>
              {booting ? (
                <p id={resetHintId} className="settings__hint">
                  Checking your account…
                </p>
              ) : null}
            </>
          )}
        </div>
        <p className={cx('settings__reset-status', resetStatus?.tone === 'error' && 'is-error')} role="status">
          {resetStatus ? resetStatus.text : null}
        </p>
      </div>

      <p className="settings__about small-caps">
        Momentum · v1 · {signedIn ? 'synced to your account' : 'data stays on this device'}
      </p>
    </section>
  );
}
