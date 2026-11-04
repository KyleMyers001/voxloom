import type {
  CleanupAttempt,
  CleanupModelStatus,
  CleanupRequest,
  CleanupResult,
} from './types';
import type { CleanupDownloadProgress } from './modelDownload';

export interface CleanupEngine {
  acquire?(requestId: string, modelId: string): Promise<void>;
  cancel(requestId: string): Promise<void>;
  dispose?(): Promise<void>;
  release?(requestId: string): Promise<void>;
  // Bare-string adapters provide no model-attempt evidence. Native returns
  // verified identity on success/failure and signals launch for live UI state.
  run(
    request: CleanupRequest,
    onStarted?: (attempt: CleanupAttempt) => void,
  ): Promise<string | CleanupResult>;
}

export interface CleanupModelStore {
  importModel(): Promise<CleanupModelStatus | null>;
  status(): Promise<CleanupModelStatus>;
  /** BUS-181: one-click download; stores without it show Import only. */
  download?(onProgress?: (progress: CleanupDownloadProgress) => void): Promise<CleanupModelStatus>;
  /** Stops a running download; false when none was running. */
  cancelDownload?(): Promise<boolean>;
}
