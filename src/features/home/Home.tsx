import { useApp } from '../../app/AppContext';
import { isTauriEnv } from '../../services/capture/captureService';
import type { UseDogfoodCaptureResult } from '../../services/stt/useDogfoodCapture';
import { DictateCard } from './DictateCard';
import { HomeHero } from './HomeHero';
import { RecentCard } from './RecentCard';

interface HomeProps {
  /** Shared App-level dogfood capture (also driven by global gesture). */
  dogfood: UseDogfoodCaptureResult;
  onToast: (message: string) => void;
}

export function Home({ dogfood, onToast }: HomeProps) {
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
      <HomeHero isNative={isNative} />
      <DictateCard dogfood={dogfood} isNative={isNative} onCopy={(t) => { void copy(t); }} />
      <RecentCard onCopy={(t) => { void copy(t); }} />
    </div>
  );
}
