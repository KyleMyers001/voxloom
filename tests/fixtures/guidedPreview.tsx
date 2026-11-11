// Browser-only synthetic permission/model fixtures. Not a production entry point.
import { createRoot } from 'react-dom/client';
import { AppProvider } from '../../src/app/AppContext';
import { Onboarding } from '../../src/features/onboarding/Onboarding';
import type { SetupBoundary } from '../../src/features/onboarding/guidedSetup';
import '../../src/styles/index.css';
const params = new URLSearchParams(location.search);
const step = Number(params.get('step') ?? 0);
const appearance = params.get('theme') ?? 'dark';
document.documentElement.dataset.appearanceResolved = appearance;
const boundary: SetupBoundary = {
  native: true,
  query: async () => ({ microphone: 'authorized', accessibility: 'authorized' }),
  request: async () => {}, openSettings: async () => {},
  readiness: async (modelId) => ({ modelId, ready: true, reason: null }),
  download: async () => {}, cancelDownload: async () => {},
  activeShortcut: () => 'Ctrl + Shift + Space',
};
createRoot(document.getElementById('root')!).render(<AppProvider><Onboarding boundary={boundary} onClose={() => {}} progressStorage={{ read: () => JSON.stringify({ version: 1, step, holdDone: step === 4, tapDone: step === 4, mode: 'hold', modelId: 'whisper-base.en', shortcut: 'Ctrl + Shift + Space' }), write: () => {} }} /></AppProvider>);
