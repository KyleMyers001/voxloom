# Privacy and local data

Voxloom transcribes on your Mac. Nothing you dictate is sent to a remote
service. The only network traffic is a Whisper model download, and only when
you start it (see `src-tauri/src/stt/catalog.rs` for the exact URLs).

## Transcripts are stored as plain text

The desktop app keeps its data as **unencrypted JSON** in its app data folder:

```text
~/Library/Application Support/com.voxloom.prototype/
├── history.json      transcript text, status, duration, model, timestamp, delivery outcome
├── *.json.unreadable-*.bak  backups of a store file Voxloom couldn't read (see below)
├── dictionary.json   your custom words
├── settings.json     preferences
└── models/           downloaded Whisper model files (*.bin)
```

`history.json` is not encrypted. Any process running as your macOS user, and
anything that copies your home folder (Time Machine, other backup or sync
tools), can read your transcripts. FileVault protects it only while the Mac is
shut down; once you've logged in, a locked screen doesn't keep it from other
processes running as you. Recorded audio is never saved.

## Deleting transcripts

- **One transcript:** History → the row's **Delete transcript** (trash) button.
- **All transcripts, and stop keeping them:** Settings → Privacy →
  **Transcript retention → Off**. `history.json` is rewritten with no records
  right away, new dictations are not stored, and transcripts already loaded
  are cleared from History and Home. The one exception is a dictation that
  failed to insert and still offers recovery on Home; it stays in memory only
  (never on disk) until its recovery window ends or you restart Voxloom.
  If Voxloom couldn't load `history.json` (it shows an error banner), Off
  can't rewrite it; quit Voxloom and delete the files manually as below.
- **Keep only recent ones:** **30 days** drops older records on every save
  and on launch. **Forever** keeps everything until you delete it.
- **Everything, manually:** quit Voxloom and delete the folder above, or at
  least these files in it:
  - `history.json`
  - `*.unreadable-*.bak` (see below)
  - `history.json.tmp`, a temporary file a crash during save can leave behind.
    It may hold transcripts. Voxloom deletes it on launch once `history.json`
    loads, but keeps it if `history.json` is missing or damaged, because it
    may then be the only good copy. If Voxloom crashes after writing the
    `.tmp` but before renaming it, that newest save is discarded on launch.

  A missing `history.json` is treated as empty history on next launch.
- **Unreadable-file backups:** if Voxloom can't read `history.json` (corrupt,
  or from a different version), it first copies it to
  `history.json.unreadable-<timestamp>.bak` in the same folder. The same applies
  to `dictionary.json` and `settings.json`. These copies may hold old
  transcripts in plain text, and **retention never deletes them**. To remove
  them, quit Voxloom and delete them by hand, for example:
  `rm ~/Library/Application\ Support/com.voxloom.prototype/*.unreadable-*.bak`

Deleting a file does not remove copies already captured by backups.

## Accessibility

With Accessibility permission, Voxloom inserts the transcript into the focused
field by writing it as the field's selected text. To do that safely it reads:

- the focused app's name, and the focused element's role, subrole and whether
  it has a DOM identifier, to find the right field;
- the focused element's value, to check the text was inserted;
- the window title, the document path (`AXDocument`) and, in browsers, the
  page URL (`AXURL`), to notice when the target has changed.

None of this is saved, and insertion itself never uses the clipboard (see
Clipboard below for the optional fallback).

## Clipboard

If clipboard fallback is on and direct insertion isn't safe, the transcript
is copied to the system clipboard, where other apps and clipboard managers can
read it. Turn fallback off in Settings if that matters to you.

## macOS private API (`macOSPrivateApi`)

`src-tauri/tauri.conf.json` sets `app.macOSPrivateApi: true` (and Cargo
enables Tauri's `macos-private-api` feature).

- **Why:** the floating dictation waveform (`src-tauri/src/overlay.rs`) is a
  transparent, non-focusable window. On macOS, Tauri can only make a webview
  window transparent through non-public AppKit/WebKit APIs, which this flag
  turns on. It is still needed while the overlay is transparent.
- **Implications:**
  - Voxloom **can't be distributed through the Mac App Store**; App Review
    rejects apps that use private APIs. Direct download (Developer ID signed
    and notarized) is unaffected.
  - Private APIs can change or break in a macOS update without notice, so the
    overlay's transparency should be re-checked on each new macOS release.
  - It does not grant extra permissions. Microphone and Accessibility access
    still go through the normal macOS privacy prompts.
- **To drop it:** make the overlay an opaque window (or a native panel), then
  remove the flag and the Cargo feature.
