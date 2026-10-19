import { useApp } from '../../app/AppContext';
import { AppTile } from '../../components/AppTile';
import { KeyCombo } from '../../components/KeyCombo';
import { useShortcutActive } from '../../services/shortcut/activeShortcut';
import { NO_SHORTCUT_HEADING, NO_SHORTCUT_HINT } from '../settings/shortcutCopy';
import { SegmentedControl } from '../../components/SegmentedControl';
import { isCleanupActive } from '../../domain/cleanup';
import type { WritingStyle } from '../../domain/types';
import type { CleanupModelStore } from '../../services/cleanup/contracts';
import { cleanupShown, useCleanupModel } from '../settings/useCleanupModel';

const styles: { value: WritingStyle; label: string }[] = [
  { value: 'formal', label: 'Formal' },
  { value: 'casual', label: 'Casual' },
  { value: 'very-casual', label: 'Very Casual' },
];

/** Hero: shortcut key caps + writing-style segmented control (H1). */
export function HomeHero({ cleanupModelStore, isNative }: {
  /** Test seam: cleanup model status (defaults to native). */
  cleanupModelStore?: CleanupModelStore;
  isNative: boolean;
}) {
  const { settings, state } = useApp();
  const active = useShortcutActive();
  const cleanupActive = isCleanupActive(state.settings);
  // Same gate as the Local cleanup block in Settings.
  const shown = cleanupShown(useCleanupModel(isNative, cleanupModelStore), cleanupActive);
  return (
    <section aria-labelledby="home-title" className="home-hero">
      <span className="home-hero__orb"><AppTile size="lg" /></span>
      <div>
        <h1 id="home-title">
          {active
            ? <>Hold <KeyCombo combo={state.settings.shortcut} /> to dictate</>
            : NO_SHORTCUT_HEADING}
        </h1>
        {!active && <p className="home-hero__none">{NO_SHORTCUT_HINT}</p>}
        <p>Speak in any app. Release to type. Transcribed locally with Whisper.</p>
        <div className="home-hero__style">
          <span className="fine">
            {!isNative ? 'Writing style'
              : !shown ? 'Style preference · cleanup not available yet'
              : cleanupActive ? 'Writing style · local cleanup on'
              : 'Style preference · local cleanup is off'}
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
