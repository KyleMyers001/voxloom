/// Per-dictation wiring for optional local cleanup (BUS-16 PR 2c): snapshot
/// the settings when capture stops, run the stage, and build provenance.

import type { CleanupProvenance, WritingStyle } from '../../domain/types';
import type { CleanupEngine } from '../cleanup/contracts';
import { snapshotDictionary } from '../cleanup/prompt';
import { createCleanupProvenance } from '../cleanup/provenance';
import type { CleanupOutcome, CleanupSnapshot } from '../cleanup/types';
import { cleanTranscript } from '../dictation/cleanupStage';
import { signalFor } from '../dictation/signal';

export interface DogfoodCleanupSettings {
  /** `isCleanupActive(settings)`: enabled AND explicitly opted in. */
  active: boolean;
  dictionary: readonly string[];
  modelId: string | null;
  style: WritingStyle;
}

export interface DogfoodCleanup {
  /** Undefined when cleanup is off: the path then skips it entirely. */
  stage?: (text: string) => Promise<CleanupOutcome>;
  /** History provenance; undefined when off (the record defaults to skipped). */
  provenance(outcome: CleanupOutcome | undefined): Promise<CleanupProvenance | undefined>;
}

export function prepareDogfoodCleanup(input: {
  controller: AbortController;
  engine: () => CleanupEngine;
  onStart: () => void;
  requestId: string;
  settings: DogfoodCleanupSettings;
  userCancelled: () => boolean;
}): DogfoodCleanup {
  if (!input.settings.active) return { provenance: async () => undefined };
  const snapshot: CleanupSnapshot = {
    dictionary: snapshotDictionary(input.settings.dictionary),
    enabled: true,
    modelId: input.settings.modelId,
    style: input.settings.style,
  };
  return {
    provenance: (outcome) => createCleanupProvenance(snapshot, outcome),
    stage: (text) => {
      input.onStart();
      return cleanTranscript({
        engine: input.engine(),
        rawText: text,
        requestId: input.requestId,
        signal: signalFor(input.controller),
        snapshot,
        userCancelled: input.userCancelled,
      });
    },
  };
}
