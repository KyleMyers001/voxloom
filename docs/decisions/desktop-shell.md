# Desktop shell decision

BUS-4 uses a minimal Tauri 2 shell around the same Vite application shown in
the browser. This is provisional: global shortcuts, audio capture, local model
execution, insertion, persistence, packaging, and updates are outside this
prototype and may change the eventual shell decision.

The shell defines no application capabilities and no Rust commands. Product
components do not import Tauri APIs. The mock permission and device controls
cannot request operating-system access.
