import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { isSyncConfigured } from '../../lib/sync/firebase';
import { useSyncStore } from '../../lib/sync/syncStore';
import { resetPassword, signIn, signOutUser, signUp } from '../../lib/sync/auth';
import { deleteCloudData } from '../../lib/sync/engine';
import type { SyncUser } from '../../lib/sync/types';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { InlineConfirm } from './InlineConfirm';
import { describeSync, errorMessage } from './syncText';
import './fields.css';
import './SyncSection.css';

/** A line under the controls: a confirmation ("Reset email sent…") or an inline error. */
interface Message {
  tone: 'ok' | 'error';
  text: string;
}

interface MessageProps {
  message: Message | null;
  onMessage: (message: Message | null) => void;
}

const LEAD = 'Back up and sync your trackers across your devices. Only you can read your data.';
const GENERIC_ERROR = 'Something went wrong. Try again in a moment.';
const DELETE_FAILED = 'Could not delete your cloud data. Check your connection and try again.';
/** Firebase's own minimum; checking here saves a round trip. */
const PASSWORD_MIN = 6;

/** The relative time ticks every 30 s and catches up when the app comes back to the foreground. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const tick = (): void => setNow(Date.now());
    tick();
    const timer = setInterval(tick, 30_000);
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active]);

  return now;
}

/**
 * Settings → "Sync across devices" (SPEC §13.6). Renders nothing when the Firebase env is not
 * configured, so a local-only build never shows any of this.
 */
export function SyncSection() {
  if (!isSyncConfigured()) return null;
  return <SyncCard />;
}

function SyncCard() {
  const titleId = useId();
  const user = useSyncStore((s) => s.user);
  const booting = useSyncStore((s) => s.booting);
  // Lives here so a note left while signed in ("Signed out. …") survives the switch to the form.
  const [message, setMessage] = useState<Message | null>(null);

  return (
    <section className="card settings__group sync" aria-labelledby={titleId}>
      <h3 id={titleId} className="display display--md sync__title">
        Sync across devices
      </h3>
      {user ? (
        <Account user={user} message={message} onMessage={setMessage} />
      ) : booting ? (
        <Booting />
      ) : (
        <SignInForm message={message} onMessage={setMessage} />
      )}
    </section>
  );
}

/** Firebase is still restoring a saved session: a quiet line instead of a sign-in form that may vanish. */
function Booting() {
  return (
    <>
      <p className="sync__lead">{LEAD}</p>
      <p className="sync__status" aria-live="polite">
        <span className="sync__dot" data-state="connecting" aria-hidden="true" />
        <span>Checking your account…</span>
      </p>
    </>
  );
}

/* ---------- Signed out ---------- */

type FormBusy = 'signIn' | 'signUp' | 'reset' | null;

function SignInForm({ message, onMessage }: MessageProps) {
  const id = useId();
  const emailId = `${id}-email`;
  const passwordId = `${id}-password`;
  const messageId = `${id}-message`;
  // "Sync could not start…" from bootstrap.ts, shown until a sign-in attempt replaces it.
  const startupError = useSyncStore((s) => (s.status === 'error' ? s.error : null));

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState<FormBusy>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const trimmedEmail = email.trim();
  const disabled = busy !== null;
  const shown: Message | null = message ?? (startupError ? { tone: 'error', text: startupError } : null);

  function reject(text: string, field: HTMLInputElement | null): void {
    onMessage({ tone: 'error', text });
    field?.focus();
  }

  /** Runs one auth request behind the busy state; resolves true when it succeeded. */
  async function run(
    kind: Exclude<FormBusy, null>,
    request: () => Promise<void>,
    done: Message | null,
  ): Promise<boolean> {
    setBusy(kind);
    onMessage(null);
    try {
      await request();
      onMessage(done);
      return true;
    } catch (error) {
      onMessage({ tone: 'error', text: errorMessage(error, GENERIC_ERROR) });
      return false;
    } finally {
      setBusy(null);
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (disabled) return;
    if (trimmedEmail === '') return reject('Enter your email.', emailRef.current);
    if (password === '') return reject('Enter your password.', passwordRef.current);
    void run('signIn', () => signIn(trimmedEmail, password), null).then((ok) => {
      if (ok) setPassword('');
    });
  }

  function onCreate(): void {
    if (disabled) return;
    if (trimmedEmail === '') return reject('Enter your email.', emailRef.current);
    if (password.length < PASSWORD_MIN) {
      return reject(`Choose a password of at least ${PASSWORD_MIN} characters.`, passwordRef.current);
    }
    void run('signUp', () => signUp(trimmedEmail, password), null).then((ok) => {
      if (ok) setPassword('');
    });
  }

  function onForgot(): void {
    if (disabled) return;
    if (trimmedEmail === '') return reject('Enter your email first, then tap Forgot password.', emailRef.current);
    void run('reset', () => resetPassword(trimmedEmail), {
      tone: 'ok',
      text: `Reset email sent to ${trimmedEmail}. Follow the link in it to choose a new password.`,
    });
  }

  return (
    <>
      <p className="sync__lead">{LEAD}</p>
      <form className="sync__form" onSubmit={onSubmit} noValidate aria-busy={disabled || undefined}>
        <div className="field">
          <label htmlFor={emailId} className="field__label">
            <span className="small-caps">Email</span>
          </label>
          <input
            id={emailId}
            ref={emailRef}
            className="field__input"
            type="email"
            name="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            inputMode="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="next"
            onKeyDown={(e) => {
              // The key reads "next": move on to the password instead of submitting a half-filled
              // form (Enter in the password field, labelled "go", is what submits).
              if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
              e.preventDefault();
              passwordRef.current?.focus();
            }}
            placeholder="you@example.com"
            disabled={disabled}
            required
            aria-describedby={messageId}
          />
        </div>

        <div className="field">
          <label htmlFor={passwordId} className="field__label">
            <span className="small-caps">Password</span>
          </label>
          <div className="sync__password">
            <input
              id={passwordId}
              ref={passwordRef}
              className="field__input"
              type={reveal ? 'text' : 'password'}
              name="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              enterKeyHint="go"
              disabled={disabled}
              required
              aria-describedby={messageId}
            />
            <button
              type="button"
              className="sync__reveal small-caps"
              onClick={() => setReveal((v) => !v)}
              aria-label={reveal ? 'Hide password' : 'Show password'}
              aria-controls={passwordId}
              disabled={disabled}
            >
              {reveal ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>

        <p id={messageId} className={cx('sync__message', shown?.tone === 'error' && 'is-error')} role="status">
          {shown ? shown.text : null}
        </p>

        <div className="sync__actions">
          <Button type="submit" disabled={disabled} aria-busy={busy === 'signIn' || undefined}>
            {busy === 'signIn' ? 'Signing in…' : 'Sign in'}
          </Button>
          <Button variant="subtle" onClick={onCreate} disabled={disabled} aria-busy={busy === 'signUp' || undefined}>
            {busy === 'signUp' ? 'Creating account…' : 'Create account'}
          </Button>
        </div>
        <button
          type="button"
          className="sync__link"
          onClick={onForgot}
          disabled={disabled}
          aria-busy={busy === 'reset' || undefined}
        >
          {busy === 'reset' ? 'Sending reset email…' : 'Forgot password?'}
        </button>
      </form>
    </>
  );
}

/* ---------- Signed in ---------- */

interface AccountProps extends MessageProps {
  user: SyncUser;
}

type AccountBusy = 'signOut' | 'delete' | null;

function Account({ user, message, onMessage }: AccountProps) {
  const status = useSyncStore((s) => s.status);
  const pending = useSyncStore((s) => s.pending);
  const lastSyncedAt = useSyncStore((s) => s.lastSyncedAt);
  const error = useSyncStore((s) => s.error);
  const now = useNow(status === 'synced' && lastSyncedAt !== null);
  const line = describeSync({ status, pending, lastSyncedAt, error }, now);
  // Announced politely when the status changes (Synced → Offline → an error). The visible line also
  // carries the relative time, which ticks every 30 s and must not be read out each time, so the live
  // region holds the status alone.
  const announcement = line.tone === 'synced' ? 'Synced' : line.text;
  // Sign-out flushes queued writes only while online (auth.ts); offline, the changes stay here and
  // the next sign-in's first-contact merge uploads them.
  const hint =
    status === 'offline' && pending
      ? 'Signing out keeps everything on this device. Changes made offline are merged into your account the next time you sign in.'
      : pending
        ? 'Signing out keeps everything on this device. Changes still syncing are sent first.'
        : 'Signing out keeps everything on this device.';

  const [busy, setBusy] = useState<AccountBusy>(null);
  const [confirming, setConfirming] = useState(false);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const disabled = busy !== null;

  function closeConfirm(): void {
    setConfirming(false);
    // The Delete button mounts again on this render; focus it once it exists.
    requestAnimationFrame(() => deleteRef.current?.focus());
  }

  async function onSignOut(): Promise<void> {
    setBusy('signOut');
    onMessage(null);
    try {
      await signOutUser();
      onMessage({ tone: 'ok', text: 'Signed out. Your trackers stay on this device.' });
    } catch (err) {
      onMessage({ tone: 'error', text: errorMessage(err, GENERIC_ERROR) });
    } finally {
      setBusy(null);
    }
  }

  /**
   * Two steps, both owned by the engine: deleteCloudData() detaches the mirror itself (so the emptied
   * collection is never applied to this device), rejects with a readable sentence on failure and
   * resumes syncing when nothing was deleted. Only after it resolves is the account signed out.
   */
  async function onDelete(): Promise<void> {
    setBusy('delete');
    onMessage(null);
    try {
      await deleteCloudData(user.uid);
    } catch (err) {
      const text = errorMessage(err, DELETE_FAILED);
      const sync = useSyncStore.getState();
      // A half-finished sweep leaves the engine paused with this same sentence on the status line
      // just above; add what it does not say rather than repeat it.
      onMessage(
        sync.status === 'error' && sync.error === text
          ? { tone: 'ok', text: 'Your trackers are still on this device.' }
          : { tone: 'error', text },
      );
      setBusy(null);
      closeConfirm();
      return;
    }
    try {
      await signOutUser();
      onMessage({ tone: 'ok', text: 'Cloud data deleted. Your trackers stay on this device.' });
    } catch (err) {
      onMessage({
        tone: 'error',
        text: `Your cloud data is deleted, but signing out did not work. ${errorMessage(err, 'Tap Sign out to try again.')}`,
      });
    } finally {
      setBusy(null);
      closeConfirm();
    }
  }

  return (
    <div className="sync__account">
      <p className="small-caps">Signed in as</p>
      <p className="sync__email">{user.email || 'Signed in'}</p>
      <p className={cx('sync__status', line.tone === 'error' && 'is-error')}>
        <span className="sync__dot" data-state={line.tone} aria-hidden="true" />
        <span>{line.text}</span>
      </p>
      <p className="sr-only" role="status">
        {announcement}
      </p>

      <p className={cx('sync__message', message?.tone === 'error' && 'is-error')} role="status">
        {message ? message.text : null}
      </p>

      <div className="sync__manage">
        {confirming ? (
          <InlineConfirm
            title="Delete your cloud data?"
            body="This removes your trackers from the cloud and signs you out. Your data stays on this device."
            confirmLabel="Delete"
            busy={busy === 'delete'}
            busyLabel="Deleting…"
            onConfirm={() => void onDelete()}
            onCancel={closeConfirm}
          />
        ) : (
          <>
            <Button
              variant="subtle"
              onClick={() => void onSignOut()}
              disabled={disabled}
              aria-busy={busy === 'signOut' || undefined}
            >
              {busy === 'signOut' ? 'Signing out…' : 'Sign out'}
            </Button>
            <Button ref={deleteRef} variant="danger" onClick={() => setConfirming(true)} disabled={disabled}>
              Delete cloud data
            </Button>
            <p className="sync__hint">{hint}</p>
          </>
        )}
      </div>
    </div>
  );
}
