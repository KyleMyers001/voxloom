import { useApp } from '../../app/AppContext';
import { AppTile } from '../../components/AppTile';
import { KeyCombo } from '../../components/KeyCombo';
import { SegmentedControl } from '../../components/SegmentedControl';
import type { WritingStyle } from '../../domain/types';

const styles: { value: WritingStyle; label: string }[] = [
  { value: 'formal', label: 'Formal' },
  { value: 'casual', label: 'Casual' },
  { value: 'very-casual', label: 'Very Casual' },
];

/** Hero: shortcut key caps + writing-style segmented control (H1). */
export function HomeHero({ isNative }: { isNative: boolean }) {
  const { settings, state } = useApp();
  return (
    <section aria-labelledby="home-title" className="home-hero">
      <span className="home-hero__orb"><AppTile size="lg" /></span>
      <div>
        <h1 id="home-title">
          Hold <KeyCombo combo={state.settings.shortcut} /> to dictate
        </h1>
        <p>Speak in any app. Release to type. Transcribed locally with Whisper.</p>
        <div className="home-hero__style">
          <span className="fine">
            {isNative ? 'Style preference · cleanup not available yet' : 'Writing style'}
          </span>
          <SegmentedControl
            label="Current writing style"
            onChange={(value) => settings.update({ key: 'style', value })}
            options={styles}
            value={state.settings.style}
          />
        </div>
      </div>
    </section>
  );
}
