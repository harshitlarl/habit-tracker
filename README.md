# Momentum

A calm, personal habit tracker that lives on your iPhone's Home Screen.

You create **trackers** — "Gym", "Study 2 hours", "Wake up by 8 AM" — choose which weekdays each
one is due, and check them off as the day goes. Momentum shows the week Monday to Sunday, keeps your
streaks, draws your progress, and says something kind along the way. Everything lives on your phone:
no account is needed and nothing is tracked. When you want your trackers backed up and shared between
devices, sign in from Settings and they sync through a private space in the cloud; until then, nothing
leaves the device.

Live at **https://harshitlarl.github.io/habit-tracker/**

## What it does

- **Today** — the trackers due today, each with an oversized check. A ring counts done/due, a short
  motivation line changes with your day (same words all day, no re-rolling), and streak chips appear
  once a tracker reaches two days. Anything not scheduled today sits in a collapsed section and can
  still be checked as a bonus. Finish everything due and you get a small confetti burst.
- **Week** — a Monday–Sunday ledger of every tracker. Tap any past day to fix a missed check-in,
  browse earlier weeks with ‹ ›, and read the totals and a one-line summary ("18 of 21 done · 86%").
- **Progress** — your perfect-day streak, total check-ins and this week's rate; a bar chart of the
  last eight weeks; and a card per tracker with its current streak, best streak, 30-day rate and a
  12-week heatmap. Archived trackers wait at the bottom with their final numbers and a Restore button.
- **Trackers** — add, edit, reorder, archive or delete trackers: a name, an emoji (pick one or type
  your own), one of eight colours, an optional note, and the weekdays it is due (Every day, Weekdays,
  Weekends or any mix). Settings cover the theme (System / Light / Dark), backup export and import,
  and a reset — every destructive step asks first, inside the app.
- **Sync across devices** (optional) — sign in with an email and password and your trackers and
  check-ins are mirrored to your own private space in Firebase and kept in sync on every signed-in
  device, offline changes included. Signing out keeps the local copy; **Delete cloud data** removes
  the copy in the cloud. Details under "Sync across devices" below.
- Works offline after the first load, follows your phone's light/dark setting, and respects
  Reduce Motion.

## Install it on your iPhone

1. Open **https://harshitlarl.github.io/habit-tracker/** in **Safari** (it has to be Safari for
   the Home Screen install).
2. Tap the **Share** button (the square with the arrow), then **Add to Home Screen**, then **Add**.
3. Open Momentum from the Home Screen. It runs full screen with its own icon and works offline.

Updates install themselves: when a new version has been deployed, it is picked up in the background
and used the next time you open the app.

## Your data, backups and restores

Momentum keeps everything in the browser's local storage on the device (key `momentum-v1`): your
trackers, every check-in and your settings. Nothing is sent anywhere unless you sign in to sync; even
then the device stays the copy you use, and settings never leave it.

Two things follow from that:

- The installed Home Screen app and a Safari tab are separate copies with separate data. Use the
  installed app day to day, and move data between the two (or to a new phone) with a backup — or by
  signing in on both.
- Deleting the Home Screen app, or clearing Safari's website data, deletes the data with it. Export
  a backup now and then, or keep sync on.

**Back up:** Trackers → Settings → **Export**. On the iPhone the share sheet opens; choose
**Save to Files** (or AirDrop it to a Mac). The file is `momentum-backup-YYYY-MM-DD.json` — plain,
readable JSON holding your trackers, check-ins and settings.

**Restore:** Trackers → Settings → **Import**, pick the backup file, read the summary ("1 tracker ·
42 check-ins · exported 16 Oct 2026") and confirm **Replace**. Importing replaces what is on the
device; a file that is not a Momentum backup is refused with a reason and nothing changes. Signed in,
the import replaces the account's copy as well (the confirmation says so): trackers missing from the
backup are marked deleted so they do not come back from the cloud, and a tracker you had deleted since
the backup was taken is restored under a fresh id so that deletion stays final everywhere.

**Reset this device** (at the bottom of Settings) clears this device only. Signed in, it signs out
first, so the account's copy is untouched and a later sign-in brings everything back.

## Sync across devices

Sync is optional and off until you sign in. Momentum stays local-first: the device's local storage is
the copy you use, and the cloud mirrors it.

### Using it

- **Turn it on:** Trackers → Settings → **Sync across devices** → **Create account** (an email and a
  password of at least 6 characters) or **Sign in**. **Forgot password?** sends a reset email. Whatever
  is already on the device is uploaded; whatever the account holds comes down.
- **What syncs:** trackers, check-ins and deletions. The theme and the install hint stay per device.
- **The status line** under your email says where things stand: "Synced · just now" (or "5 min ago"),
  "Syncing…" while changes travel, "Offline — changes will sync when you're back online", or a plain
  sentence when something went wrong. Changes made offline queue on the device and go out on their own
  once you are back online. Each signed-in device picks up a change within a few seconds.
- **Sign out** keeps everything on this device. Online, changes still travelling are given a moment
  to land first; offline, they stay here and are merged into the account the next time you sign in.
- **Delete cloud data** asks first, then removes your trackers from the cloud and signs you out. Your
  data stays on this device. Another device that is still signed in notices, pauses sync and keeps its
  own copy rather than mirroring the wipe — its status line explains, and signing out and back in there
  uploads that copy again.
- **Reset this device** signs out first when you are signed in (the confirmation says so), then
  clears this device only.

### How it works

Each tracker is one Firestore document at `users/{uid}/habits/{trackerId}`, holding its fields, the
set of dates it was checked and a `deleted` flag. Security rules let a signed-in user read and write
only their own `users/{uid}` tree; there is no field anyone else can see. The app listens to the
collection and writes changes as batched updates, so every signed-in device updates within moments,
and Firestore's local cache queues anything made offline.

Deleting a tracker leaves a tombstone (the document is marked `deleted`, and the id is remembered on
the device under `deletedIds`) so a device that was offline at the time learns about the deletion
instead of bringing the tracker back. Sync itself never hard-deletes; **Delete cloud data** is the only
action that removes documents. Each device also keeps a small note of the cloud state it last saw
(`momentum-sync-base:<uid>` in local storage), so a relaunch merges three-way — your changes since then
on top of the cloud's — and an un-check or a rename made elsewhere while the device was closed is not
undone. A device that has never synced the account starts with a union of both sides. If the server's
view ever lacks a document it had acknowledged before, the engine knows the cloud was wiped elsewhere and
pauses instead of mirroring it.

The Firebase SDK lives in its own `firebase-*.js` chunk under `dist/assets/`, kept out of the entry
bundle and fetched in the background after the first paint (it is needed at launch to restore a saved
sign-in). The service worker precaches it, so a signed-in device still syncs offline-first. When the
`VITE_FIREBASE_*` values are blank, the Sync card is hidden and the chunk is never loaded.

### Set up your own Firebase project

The repo is wired to the `momentum-harshitlarl` project. For a fork of your own:

1. **Create a project** at https://console.firebase.google.com → *Add project*. Analytics is not
   needed. The free **Spark** plan is enough and needs no card.
2. **Enable Email/Password sign-in:** *Build → Authentication → Get started → Sign-in method →
   Email/Password → Enable* (the first toggle only; email-link sign-in is not used) → *Save*.
3. **Create the database:** *Build → Firestore Database → Create database*. Pick the location nearest
   you (it cannot be changed later) and start in **production mode** — the rules come from the repo in
   step 5.
4. **Register a web app and copy its config:** *Project settings (gear) → Your apps → Add app → Web*.
   Skip the Hosting checkbox. From the `firebaseConfig` it shows, copy `apiKey`, `authDomain`,
   `projectId` and `appId` into `.env`:

   ```sh
   VITE_FIREBASE_API_KEY=…
   VITE_FIREBASE_AUTH_DOMAIN=<project-id>.firebaseapp.com
   VITE_FIREBASE_PROJECT_ID=<project-id>
   VITE_FIREBASE_APP_ID=…
   ```

   Put the same project id in `.firebaserc`. These values only identify the project to Google's
   client SDKs; they are public by design and `.env` is committed on purpose. Who may read what is
   decided by the rules, not by hiding them.
5. **Deploy the rules:** `npm install -g firebase-tools`, `firebase login`, then `npm run deploy:rules`
   (publishes `firestore.rules` and `firestore.indexes.json`).
6. **Build and deploy the app** anywhere under "Deploying", open it, create your account in the Sync
   card — then **close sign-ups** (next section) so nobody else can register against your project.

Do not want sync at all? Leave any of the four values empty: the Sync card disappears and no Firebase
code is ever loaded.

### Firebase console settings worth a look

- **Close sign-ups once your own account exists.** *Authentication → Settings → User actions* → untick
  **Enable create (sign-up)**. Sign-in and password reset keep working for existing accounts; the app's
  "Create account" then says "New accounts are closed on this project." This is the toggle that matters:
  the web config is public, so without it anyone who finds it could register against the project (they
  would still only ever see their own, empty tree). Turn it back on temporarily to run the real-backend
  e2e spec, which signs up and deletes a throwaway account.
- **Email enumeration protection** (same page) is on for new projects. Leave it: it is why a wrong email
  and a wrong password come back as the same calm message instead of revealing which one it was.
- **Authorized domains** (*Authentication → Settings*) matter only for OAuth providers and email-link
  sign-in. Email/password sign-in and the password-reset email work from every host below without changes.
- **Templates** (*Authentication → Templates*) set the sender name and wording of the password-reset email.
- **Rules live in the repo.** Edit `firestore.rules` and run `npm run deploy:rules`; the next deploy
  overwrites anything typed into the console's rules editor. The rules are owner-only on purpose and do
  not validate fields — the comment at the top of the file says why.
- **Optional hardening:** *Google Cloud → APIs & Services → Credentials →* the browser key → restrict
  HTTP referrers to the hosts you actually use, plus `localhost:5173/*` for `npm run dev` and
  `localhost:4174/*` for the Playwright preview. Not required, since the key only identifies the
  project, but it stops the config being reused from someone else's site. One catch: the sync spec's
  cleanup signs in through the Identity Toolkit REST API from Node, which sends no Referer, so a
  referrer-restricted key refuses it (`API_KEY_HTTP_REFERRER_BLOCKED`). The spec probes the key before
  it creates anything and, with a restricted key, skips the real-backend test and says so rather than
  leaving a throwaway account behind. To run that test anyway, keep a second, unrestricted key for
  local testing in the git-ignored `.env.local` (`VITE_FIREBASE_API_KEY=…`), which both Vite and the
  spec read ahead of `.env`.
- **Plan and location.** The project is on Spark with no billing account, so nothing can ever be
  charged; if a daily quota were somehow exhausted, sync pauses until it resets and the app keeps
  working locally. Firestore lives in `asia-south1` (Mumbai); the location is fixed once chosen.

## Development

Node 24 is what CI uses. Anything matching `engines` in `package.json` (22.12+, 24, 26+) builds and
tests fine; on Node 22 `npm install` prints an `EBADENGINE` warning because the Firebase SDK asks for
24.12+ when run in Node, which this project never does.

```sh
npm install
npm run dev          # Vite dev server (talks to the real Firebase project: use a throwaway account)
npm run typecheck    # tsc -p tsconfig.app.json --noEmit
npm test             # vitest unit tests (pinned to TZ=America/New_York for the DST cases)
npm run test:watch
npm run build        # tsc -b && vite build → dist/
npm run preview      # serve dist/ locally
npm run icons        # regenerate public/icons/* from the SVG in scripts/make-icons.mjs
npm run e2e          # build, then the Playwright suite against dist/ (see below)
```

**Unit tests** cover the pure modules: everything in `src/lib` (dates, streaks, motivation, the store
with its import validation and tombstones, the sync merge/diff logic, the saved baseline, the auth
error copy, bootstrap, and the sync engine driven against an in-memory stand-in for Firestore), the
feature model files under `src/features/**/__tests__`, and the e2e suite's API-key probe verdicts
(`e2e/helpers/identity.test.ts`). No unit test touches the network.

**End-to-end tests** (`e2e/`) drive the production build in an emulated iPhone 14 running WebKit, the
engine the app ships to. Install the browser once with `npx playwright install webkit`.
`momentum.spec.ts` walks one full first day with the app (empty state → trackers → check-ins → week →
progress → settings → backup → import → reset), audits every screen for text contrast and tap-target
size, and checks the OS colour scheme, reduced motion and offline start; `smoke.spec.ts` is the quick
version; `screenshots.spec.ts` saves a visual QA set to `e2e/screenshots/` (git-ignored).
`sync.spec.ts` checks the sign-in card, then drives the real Firebase project: it creates a throwaway
account, syncs two emulated devices in realtime, takes one offline and back, deletes the cloud data
and removes the account again — also after a failed assertion, with the outcome written to
`e2e/screenshots/sync/cleanup.json` — and finally checks that a phone which cannot reach Google still
works locally. It needs the network and sign-ups enabled in the Firebase console. Before it creates
anything it probes the API key from Node and, when Google cannot be reached or the key is restricted
by HTTP referrer, skips the real-backend test and prints why; the whole file is skipped when `.env`
holds no Firebase config, and `SYNC_E2E=0 npm run e2e` leaves it out on purpose. On a machine where
WebKit cannot launch, `PW_FALLBACK_CHROMIUM=1 npm run e2e` runs the same phone geometry in Chromium.

Stack: Vite 8, React 19, TypeScript (strict), zustand (persist → localStorage), date-fns, plain CSS
with design tokens, vite-plugin-pwa (Workbox precache, auto-update), self-hosted Fraunces and Hanken
Grotesk from Fontsource, and the Firebase web SDK (Auth + Firestore) loaded lazily. No UI kit, no
icon library, no CSS framework.

## Deploying

Momentum is a static site: `npm run build` writes everything to `dist/`, and any static host can serve
it. The committed `.env` supplies the public Firebase config at build time, so every host below builds
with sync enabled and needs no environment variables of its own. Each deployment is a complete install
— the PWA works offline from any of these URLs — and all of them talk to the same Firebase project, so a
phone installed from one URL and a laptop on another see the same data once signed in. Pick one URL per
device and stay with it: Home Screen apps and browser tabs from different origins are separate local
copies, and sync is what joins them.

| Host | URL | Deploys with | Needs |
| --- | --- | --- | --- |
| GitHub Pages | https://harshitlarl.github.io/habit-tracker/ | a push to `main` (`.github/workflows/deploy.yml`) | Pages source set to GitHub Actions |
| Firebase Hosting | https://momentum-harshitlarl.web.app | `npm run deploy:firebase` | the Firebase CLI, signed in |
| Vercel | `<project>.vercel.app` | a dashboard import or `npx vercel --prod` | nothing: `vercel.json` is in the repo |
| Netlify | `<site>.netlify.app` | a dashboard import or `npx netlify-cli deploy --build --prod` | nothing: `netlify.toml` is in the repo |

All four are free for a personal project (GitHub Pages for public repositories, Firebase's Spark plan,
Vercel's Hobby plan, Netlify's Free plan). `firebase.json`, `vercel.json` and `netlify.toml` send the
same cache headers: `sw.js`, `index.html` (also as `/`) and `manifest.webmanifest` are `no-cache`, so a
new deploy is noticed on the next launch; the hashed files under `assets/` are immutable for a year;
icons are kept for a day. Any path that is not a real file serves `index.html`. GitHub Pages sends its
own ten-minute max-age for everything, and it is the only host that serves the app from a sub-path; the
service worker's revision-stamped precache keeps updates correct there too.

### GitHub Pages

Push to `main` and GitHub Actions does the rest: `deploy.yml` checks out the repo, installs with
`npm ci`, runs the unit tests (a red suite stops the deploy), builds with `BASE_PATH=/habit-tracker/`
so every URL in `index.html`, the manifest and the service worker is prefixed for Pages, and publishes
`dist/` with `actions/deploy-pages`. The workflow can also be started by hand from the Actions tab. An
in-progress deployment is never cancelled by a newer push; queued runs collapse to the latest one.

One-time repository settings:

- **Settings → Pages → Build and deployment → Source: GitHub Actions.**
- The default branch must be `main` (or change the `branches` filter in the workflow). If the local
  repository still calls its branch `master`, rename it once with `git branch -M main` before the first
  push, or the workflow never triggers.
- The workflow derives `BASE_PATH` from the repository name, so a renamed or forked repo follows
  automatically; a user-site repository (`<user>.github.io`) would need `BASE_PATH: /` instead.

To reproduce the Pages build locally: `BASE_PATH=/habit-tracker/ npm run build`, then
`npm run preview` and open `http://localhost:4173/habit-tracker/`.

### Firebase Hosting

```sh
npm install -g firebase-tools   # the CLI is a global tool, deliberately not a project dependency
firebase login
npm run deploy:firebase         # tsc + vite build, then: firebase deploy --only hosting,firestore
npm run deploy:rules            # firebase deploy --only firestore:rules — rules only, no build
```

`.firebaserc` selects the project, so there is no `firebase use` step; `firebase.json` serves `dist/`
with the SPA rewrite and the cache headers above. The site's URL is `https://<project-id>.web.app`
(for this project https://momentum-harshitlarl.web.app, empty until the first deploy).

### Vercel

Import the repo in the dashboard (the Vite preset is detected) or run `npx vercel --prod`. `vercel.json`
adds the SPA rewrite for paths without a file extension (`assets/` and `icons/` excluded) and the cache
headers. Nothing else to configure.

### Netlify

Import the repo in the dashboard or run `npx netlify-cli deploy --build --prod`. `netlify.toml` sets the
build command, the publish directory, Node 24, the `/*` → `/index.html` 200 redirect and the cache
headers. Nothing else to configure.

## Project structure

```
index.html                  App shell: viewport-fit, iOS metas, theme-color per scheme, icon links
vite.config.ts              Vite + React + VitePWA (manifest, Workbox precache incl. fonts); base from BASE_PATH;
                            the Firebase SDK grouped into its own lazy chunk
playwright.config.ts        e2e config: iPhone 14 on WebKit against `vite preview` of dist/
vitest.config.ts            Unit-test config (src/lib, feature model tests, e2e helpers; TZ pinned)
.env                        Public Firebase web config (VITE_FIREBASE_*); blank any value to hide sync
firebase.json / .firebaserc Firebase Hosting (dist, SPA rewrite, cache headers) + Firestore rules/indexes paths
firestore.rules             Owner-only rules: users/{uid}/** readable and writable by that uid alone
firestore.indexes.json      No composite indexes needed
vercel.json / netlify.toml  The same SPA rewrite and cache headers for Vercel and Netlify
scripts/make-icons.mjs      Draws the app icon and rasterises public/icons/* with sharp
public/icons/               192/512/512-maskable PNGs, 180px apple-touch-icon, favicon.svg
.github/workflows/          deploy.yml — test, build with the Pages base path, deploy
e2e/                        Playwright specs (momentum, smoke, screenshots, sync) and helpers (contrast, Identity Toolkit)
src/
  main.tsx                  Fonts, tokens, base styles, service-worker registration, React root, initSync()
  App.tsx / App.css         Tab bar, view switching, theme → <html data-theme> and theme-color
  pwa.ts                    registerSW (autoUpdate), offline-ready event
  styles/tokens.css         Design tokens: light + dark palettes, habit colours, radii, spacing, type
  styles/base.css           Reset, typography, paper texture, utilities, focus and motion rules
  lib/                      Pure logic, fully unit-tested
    types.ts                Data model (Habit, Completions, Settings, AppData), field limits, id checks
    store.ts                zustand store: actions, strict import validation, persistence, tombstones, applyRemote
    sync/                   Optional cloud sync (SPEC §13)
      types.ts              The sync contract: LocalData, RemoteHabit, PushOp, SyncState
      firebase.ts           isSyncConfigured(), the lazy memoised loadFirebase(), clearLocalCache()
      syncStore.ts          UI-facing sync status (not persisted)
      auth.ts               Email/password wrappers with calm error copy; sign-out flushes queued writes
      merge.ts              Pure merge/diff logic (parseRemoteDoc, mergeSnapshots, mergeWithBase, diffForPush)
      baseline.ts           The cloud state each device last saw, per account (momentum-sync-base:<uid>)
      engine.ts             onSnapshot listener + store subscription → chunked write batches; deleteCloudData
      bootstrap.ts          initSync(): auth state → start/stop the engine
    dates.ts                Local-date keys, week maths, isScheduled, formatting
    streaks.ts              Streaks, completion stats, perfect days, weekly rates
    motivation.ts           Deterministic motivation lines and the week summary
    selectors.ts            activeHabits, dueHabits, habitsActiveBetween, colour helpers
    useToday.ts / useHour.ts / useReducedMotion.ts / platform.ts / ids.ts
  components/               Shared UI: Check, Ring, Sheet, Button, Chip, SegmentedControl,
                            EmptyState, Icon (inline SVG), Confetti
  features/
    today/                  TodayView, HabitRow, celebration + motivation model
    week/                   WeekView, WeekGrid, weekModel
    progress/               ProgressView, Stat, WeeklyBars, TrackerCard, Heatmap, ArchivedSection
    manage/                 ManageView, HabitEditor (bottom sheet), SettingsSection, SyncSection, InlineConfirm
    pwa/                    InstallHint banner (iOS Safari, not installed, not dismissed)
```

## The spec

`SPEC.md` is the product, design and architecture contract the app was built against — data model,
store API, streak semantics, the "warm editorial journal" design brief, the quality bar, and (section
13) the cloud-sync contract: types, module APIs, merge semantics, UI and hosting files. Start there
before changing behaviour; where the code deviates on purpose, the deviation is documented in the
file's header comment.
