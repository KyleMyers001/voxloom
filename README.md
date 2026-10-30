# Voxloom — macOS-first local dictation (work in progress)

**Download:** [latest release](https://github.com/KyleMyers001/voxloom/releases/latest) (macOS; see [Releases](#releases)).

The Tauri desktop shell captures real microphone audio, can transcribe it
locally using an explicitly downloaded Whisper model (`--features whisper`),
and attempts to insert text into the transcription-completion-time macOS target. When
insertion is unsafe or unavailable it can Copy instead, if clipboard fallback
is enabled; results report Inserted, Copied, Failed, or Unverified (Terminal
events posted without input-buffer verification). The configured global
shortcut supports hold/release and double-tap latch. Native recording shows
one bottom floating waveform driven by rate-limited microphone levels (no PCM
sent to the webview); the main app no longer duplicates it. macOS permission
and Accessibility behavior require on-device verification; Windows is not
verified.

The browser / Vite-only prototype uses synthetic capture, transcription and
focused-window shortcuts; state clears on reload. The Tauri shell persists
**Settings**, **History** and the **Word dictionary** in app data
(`settings.json`, `history.json`, `dictionary.json`). Native audio retry and
saved audio retention are not implemented. Transcripts in `history.json` are
stored as **plain text**; see [PRIVACY.md](PRIVACY.md) for where they live,
how to delete them, and why the app enables Tauri's `macOSPrivateApi`. Onboarding practice recognizes
shortcut gestures but does not transcribe speech. Cleanup styles, the cleanup
model and start-at-login are not functional desktop features yet. Development
scenario controls are excluded from production builds.

### Dictation target selection

Focus the desired field **when transcription completes**. You can start in A,
release/Stop in B, then move to C while processing: C becomes the intended
field after the final text is ready. Release/Stop stops audio immediately,
without acquiring a target or waiting for AX. Automatic 120-second/capacity
stops use the same completion-time policy.

After that snapshot, the exact field must remain focused and insertable.
Further focus changes refuse insertion, with Copy (if enabled) or Failed/manual
recovery. Password/secure fields never receive insertion. Voxloom never
restores/steals focus or submits a message. Clicking Home Stop may leave focus
in Voxloom; switch to your desired field before transcription finishes.

The first native AX observation after final STT (and engine cleanup) fixes the
target; event/IPC scheduling means this is not an atomic timestamp. If a cold or
idle-dropped Chromium/Electron AX tree is unavailable, Voxloom re-enables it on
every attempt and waits briefly (about 2.4 s at most) for the focused field in
the same, still-frontmost app; switching apps during that wait falls back (see
`docs/decisions/web-ax-reenable.md`). Cancelled/superseded work does not acquire a new
target or dispatch new delivery writes; any already-dispatched native insertion
cannot be retracted and retains native exact-target checks.

### Apple Terminal

The exact system Apple Terminal app has a separate guarded Unicode-event route
for validated text areas. It rejects control characters and line separators,
never sends Enter or uses clipboard transport, and never automatically copies
or retries after any events are posted. Complete/partial dispatch stays
**Unverified** in the result and History; inspect the prompt before using Copy.
Printable text can still trigger actions in terminal modes or TUIs: no Enter
is not a universal no-execution guarantee. Other terminal apps are not enabled
by this route. See `docs/decisions/apple-terminal-delivery.md` for guards,
evidence and remaining live checks.

The marketing website is maintained separately in
[`voxloom-site`](https://github.com/KyleMyers001/voxloom-site) and hosted at
https://voxloom-site-seven.vercel.app. Website changes and deployments do not
require a desktop app release.

## Browser

```sh
npm install
npm run dev
```

Open `http://localhost:1420`.

## macOS desktop

**Minimum macOS: 13.1 (Ventura).** The UI runs in the system WKWebView, so it
needs the WebKit that ships with Safari 16.2: `color-mix()` (Safari 16.2),
`:has()` (15.4), `Array.prototype.at()` (15.4) and `inert` (15.5). Declared in
`src-tauri/tauri.conf.json` → `bundle.macOS.minimumSystemVersion`.

With the Rust and macOS build toolchains installed:

```sh
npm run tauri -- dev
```

Dev runs under the Tauri helper; System Settings → Privacy → Microphone may
list your terminal (e.g. WezTerm), not Voxloom. For real TCC client identity,
build a packaged `.app` (see below).

Windows is not verified by this repository.

### Packaged `.app` (TCC identity)

```sh
# Mic / UI identity smoke
npm run tauri -- build --bundles app

# Full local STT (requires cmake)
brew install cmake   # once
npm run tauri -- build --bundles app -- --locked --features whisper
```

App path:

```text
src-tauri/target/release/bundle/macos/Voxloom.app
```

Open it, request mic access, then confirm **Voxloom** appears under
System Settings → Privacy & Security → Microphone.

After build, confirm codesign embedded the mic entitlement (ad-hoc or
Developer ID):

```sh
npm run macos:assert-entitlements
# codesign -d --entitlements :- src-tauri/target/release/bundle/macos/Voxloom.app
```

If the dump is empty, the app kept only the linker's ad-hoc signature, which
does not embed `src-tauri/Entitlements.plist`. Tauri runs `codesign` only when
a signing identity resolves; `bundle.macOS.signingIdentity` is `"-"` (ad-hoc)
for that reason. `npm run macos:assert-entitlements -- --repair` re-signs it.

To sign with a Developer ID instead, so permissions survive rebuilds, export
`APPLE_SIGNING_IDENTITY` (and `APPLE_TEAM_ID`) before building. See
[docs/macos-signing.md](docs/macos-signing.md).

## Releases

macOS builds are published as **draft** GitHub Releases by
`.github/workflows/release.yml` whenever a `v*` tag is pushed. Each release
has a universal `.dmg`, a zipped `.app` and `SHA256SUMS`.

Cutting a release:

```sh
npm run release:bump -- 0.2.0   # syncs package.json, tauri.conf.json, Cargo.toml (+ locks), commits, tags v0.2.0
git push && git push origin v0.2.0
```

Then review the draft release on GitHub, edit the notes (template:
`.github/release-notes.md`; changes are auto-generated from merged PRs), and
publish it. The workflow fails if the tag and manifest versions differ
(`npm run release:check-version -- v0.2.0`).

**Signing:** builds are ad-hoc signed and labeled **UNSIGNED** until these
secrets exist in the protected `release` Environment, after which tag pushes
are Developer ID signed, notarized and stapled automatically:
`APPLE_CERTIFICATE` (base64 `.p12`), `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY`, `APPLE_TEAM_ID` (required for every signed build),
plus the App Store Connect API key: `APPLE_API_KEY` + `APPLE_API_ISSUER` +
`APPLE_API_PRIVATE_KEY` (`.p8` contents). Apple ID notarization isn't
supported.
Manual workflow runs never receive these secrets and always build ad-hoc.
Setup steps:
[docs/macos-signing.md](docs/macos-signing.md).

**Test build without releasing:** run the *Release* workflow manually
(Actions → Release → Run workflow). It uploads the build as a workflow
artifact and does not create a release.

## Local STT (whisper.cpp)

Speech-to-text is local-first (see `docs/decisions/local-stt-whisper.md`).
The TypeScript layer talks to `SttEngine` / `SttModelStore`; a mock adapter
backs UI tests. The Tauri shell exposes `stt_*` commands for model
download (explicit user action only) and transcription.

Model downloads are pinned: `stt/catalog.rs` lists a fixed Hugging Face
revision plus each file's exact size and SHA-256, and `src-tauri/src/model_fetch`
verifies both before the atomic rename. A mismatch deletes the partial file and
reports `download-corrupted`, which the Models tab shows as "Download was
damaged. Nothing was saved." with Retry; sizes and hashes go only to the
native log. Downloads use one shared HTTPS-only client (an
https→http redirect is refused) with a 30 s connect timeout and a 30 s read
timeout, so a stalled transfer fails instead of hanging; there is no overall
time limit. Model files already on disk (including ones downloaded before
pinning) are checked once against the same size and SHA-256 in the background
after launch; dictation keeps working while that runs. A passing file gets a
`<file>.verified` marker (hash, size and modified time) so it isn't hashed
again. A file that fails is kept, shows as damaged in the Models tab with
Retry, and isn't used for transcription. A file that can't be opened (for
example after its permissions change, even if it was verified before) shows
"Couldn't open the model file" with Retry; dictation tries to open it again
each time and uses it once it opens, and that file is then checked once more
in the background. A file that opens but can't be read during the check stays
failed until Retry download or the next launch.

Real whisper.cpp linkage is **opt-in** on macOS:

```sh
brew install cmake   # once
npm run tauri -- dev -- --features whisper
```


## Verification

Pull requests targeting `main` run GitHub Actions CI on Node 24 and Ubuntu:
ESLint, Vitest unit tests, the TypeScript/Vite build, and Playwright Chromium
browser tests. To run the same checks locally after `npm ci`:

```sh
PLAYWRIGHT_BROWSERS_PATH=.playwright-browsers npx playwright install chromium
npm run lint
npm run test:unit
npm run build             # includes tsc -b (typecheck)
npm run test:e2e
```

`npm run typecheck` remains available separately. ESLint enforces the
[Google TypeScript style guide](https://google.github.io/styleguide/tsguide.html)
subset of single-quoted ordinary strings and semicolons in JS/TS sources;
existing recommended correctness rules still apply. JSX attribute quotes
remain double-quoted. This is not a full style-guide migration.
CI does not build the macOS Tauri/Rust application or verify native microphone,
Accessibility, or permission behavior; those still need on-device checks.
