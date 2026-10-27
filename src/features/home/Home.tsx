import { useApp } from '../../app/AppContext';
import { isTauriEnv } from '../../services/capture/captureService';
import type { CleanupModelStore } from '../../services/cleanup/contracts';
import type { UseDogfoodCaptureResult } from '../../services/stt/useDogfoodCapture';
import { DictateCard } from './DictateCard';
import { HomeHero } from './HomeHero';
import { RecentCard } from './RecentCard';

interface HomeProps {
  /** Shared App-level dogfood capture (also driven by global gesture). */
  dogfood: UseDogfoodCaptureResult;
  /** Test seam: cleanup model status for the hero caption. */
  cleanupModelStore?: CleanupModelStore;
  onToast: (message: string) => void;
}

export function Home({ cleanupModelStore, dogfood, onToast }: HomeProps) {
  const { clipboard } = useApp();
  const isNative = isTauriEnv();

  async function copy(text: string) {
    try {
      await clipboard.copy(text);
      onToast('Copied to clipboard');
    } catch {
      onToast('Copy failed');
    }
  }

  return (
    <div className="home">
      <HomeHero cleanupModelStore={cleanupModelStore} isNative={isNative} />
      <DictateCard dogfood={dogfood} isNative={isNative} onCopy={(t) => { void copy(t); }} />
      <RecentCard onCopy={(t) => { void copy(t); }} />
    </div>
  );
}
