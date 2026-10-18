## Voxloom v{{VERSION}}

{{SIGNING_NOTE}}

### Install

1. Download `Voxloom_{{VERSION}}_macos_*.dmg` (or the zipped `.app`) below and
   check it against `SHA256SUMS`: `shasum -a 256 -c SHA256SUMS --ignore-missing`.
2. Open the dmg and drag **Voxloom** to Applications.
3. Launch Voxloom from Applications.

### Permissions (macOS)

- **Microphone**: requested on first dictation. Voxloom should appear by name
  under System Settings → Privacy & Security → Microphone.
- **Accessibility**: needed to insert text into other apps. Enable Voxloom
  under System Settings → Privacy & Security → Accessibility.

### Speech model

Transcription runs locally with whisper.cpp. The Whisper model is **not**
bundled; download it separately as described in the README
("Local STT (whisper.cpp)").

### Known limitations

- macOS only (minimum macOS 13.1 (Ventura)); Windows and Linux are not supported yet.
- No auto-update; download new versions from the Releases page.
- _Edit before publishing: add release-specific limitations here._
