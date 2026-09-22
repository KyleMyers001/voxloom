import type { DictationState } from "../../domain/types";

/** Overlay is visible only while listening or processing (AC4). */
export function isOverlayVisible(kind: DictationState["kind"]): boolean {
  return kind === "listening" || kind === "processing";
}

export type OverlayWaveform = "silent" | "speaking" | "processing";

export function overlayWaveformFromDictation(
  dictation: DictationState,
): OverlayWaveform | null {
  if (dictation.kind === "listening") return dictation.waveform;
  if (dictation.kind === "processing") return "processing";
  return null;
}
