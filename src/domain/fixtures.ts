import type {
  DictationRecord,
  OnboardingState,
  Settings,
} from "./types";
import { SYSTEM_DEFAULT_DEVICE_ID } from
  "../services/capture/types";

const minute = 60_000;

export function createRecords(now: number): DictationRecord[] {
  return [
    ["record-1", 3, "inserted",
      "Make retry explicit, but only when retained audio exists."],
    ["record-2", 9, "copied",
      "Run pnpm test --filter transcription."],
    ["record-3", 44, "failed",
      "Transcription failed before insertion."],
    ["record-4", 68, "inserted",
      "Assign the API contract review to Rowan, not Casey."],
    ["record-5", 91, "inserted",
      "Do not remove --dry-run from the deploy task."],
    ["record-6", 112, "copied",
      "Open src/auth/session.ts and check line 48."],
  ].map(([id, age, status, text], index) => ({
    createdAt: now - Number(age) * minute,
    durationSeconds: 7 + index * 4,
    id: String(id),
    recoveryExpiresAt: status === "failed" ? now + 10 * minute : null,
    status: status as DictationRecord["status"],
    style: index % 2 ? "casual" : "formal",
    text: String(text),
  }));
}

export const initialOnboarding: OnboardingState = {
  complete: false,
  holdTested: false,
  microphoneGranted: false,
  permissionDenied: false,
  recognizedText: "",
  shortcutCollision: false,
  step: 1,
  tapTested: false,
};

export const initialSettings: Settings = {
  appearance: "system",
  audioRetention: "off",
  clipboardFallback: true,
  language: "English (US)",
  languageModel: "Alder Text Small · local",
  // Sentinel value that the Settings mic select treats as
  // "use system default". Must match the <option> value in Settings.tsx.
  microphone: SYSTEM_DEFAULT_DEVICE_ID,
  shortcut: "Ctrl + Shift + Space",
  startAtLogin: false,
  style: "formal",
  transcriptRetention: "30-days",
  transcriptionModel: "Pine Voice Small · local",
};

export const initialWords = [
  "JSON",
  "Postgres",
  "TanStack Query",
  "TypeScript",
];
