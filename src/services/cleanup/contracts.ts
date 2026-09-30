import type {
  CleanupModelStatus,
  CleanupRequest,
} from './types';

export interface CleanupEngine {
  acquire?(requestId: string, modelId: string): Promise<void>;
  cancel(requestId: string): Promise<void>;
  dispose?(): Promise<void>;
  release?(requestId: string): Promise<void>;
  run(request: CleanupRequest): Promise<string>;
}

export interface CleanupModelStore {
  importModel(): Promise<CleanupModelStatus | null>;
  status(): Promise<CleanupModelStatus>;
}
