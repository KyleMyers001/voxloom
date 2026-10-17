import { AppTile } from '../../components/AppTile';
import { Icon } from '../../components/Icon';
import { comboLabel, isMacPlatform, KeyCombo } from '../../components/KeyCombo';
import { ScenarioPanel, type OnboardingScenario } from '../../dev/ScenarioPanel';
import type { Screen } from '../../domain/types';
import { navScreens } from './screens';
import { useShortcutActive } from '../../services/shortcut/activeShortcut';
import { NO_SHORTCUT } from '../../features/settings/shortcutCopy';

type Props = {
  screen: Screen;
  shortcut: string;
  status: string;
  onNavigate: (screen: Screen) => void;
  onScenario: (scenario: OnboardingScenario) => void;
  onReset: () => void;
};

export function Sidebar({ screen, shortcut, status, onNavigate, onScenario, onReset }: Props) {
  const active = useShortcutActive();
  return (
    <aside className="sidebar">
      <div className="brand">
        <AppTile />
        <div>
          <b className="brand__name">Voxloom</b>
          <small className="brand__status" title={active ? `${status} · ${comboLabel(shortcut)}` : undefined}>
            {status}{active && <span className="brand__label"> · {comboLabel(shortcut)}</span>}
          </small>
          {active
            ? <span className="brand__caps"><KeyCombo combo={shortcut} /></span>
            : <small className="brand__none">{NO_SHORTCUT}</small>}
        </div>
      </div>
      <nav aria-label="Voxloom screens">
        {navScreens.map(({ icon, label, value }, index) => (
          <button
            aria-current={screen === value ? 'page' : undefined}
            aria-keyshortcuts={`Alt+${index + 1}`}
            aria-label={label}
            className="nav-button"
            key={value}
            onClick={() => onNavigate(value)}
            type="button"
          >
            <Icon name={icon} />
            <span>{label}</span>
            <kbd aria-hidden="true">{isMacPlatform() ? '⌥' : 'Alt+'}{index + 1}</kbd>
          </button>
        ))}
      </nav>
      <div className="sidebar__foot">
        {import.meta.env.DEV && (
          <details className="dev-panel">
            <summary>Developer</summary>
            <ScenarioPanel onOnboarding={onScenario} onReset={onReset} />
          </details>
        )}
        <p className="sidebar__hint">
          {active ? <>
            Hold the shortcut in any app to dictate. Release to insert, or it
            copies if insertion isn’t safe.
          </> : NO_SHORTCUT}
        </p>
      </div>
    </aside>
  );
}
