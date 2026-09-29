import type {
  CleanupModelStatus,
  CleanupRequest,
} from './types';

export interface CleanupEngine {
  cancel(requestId: string): Promise<void>;
  run(request: CleanupRequest): Promise<string>;
}

export interface CleanupModelStore {
  importModel(): Promise<CleanupModelStatus | null>;
  status(): Promise<CleanupModelStatus>;
}
