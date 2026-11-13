import type { ReactNode } from 'react';
import { KeyCombo } from '../../components/KeyCombo';

/** The three guided setup steps. The spine and the welcome list share these titles. */
export const SETUP_STEP_TITLES = ['Get connected', 'Your shortcut', 'First words'] as const;

/** BUS-220 · Option A: the welcome step previews the setup steps as numbered rows. */
export function WelcomeSteps({ shortcut }: { shortcut: string }) {
  const descriptions: readonly ReactNode[] = [
    'Allow Microphone and Accessibility so Voxloom can hear you and type for you.',
    <>Keep <KeyCombo combo={shortcut} />, or pick your own keys.</>,
    'Hold your shortcut and say a short sentence, then try it hands-free.',
  ];
  // role="list" keeps list semantics in WebKit, which drops them with list-style: none.
  return <ol aria-label="Setup steps" className="guided-steps" role="list">
    {SETUP_STEP_TITLES.map((title, index) => <li key={title}>
      <span aria-hidden="true" className="guided-steps-badge">{index + 1}</span>
      <div><h3>{title}</h3><p>{descriptions[index]}</p></div>
    </li>)}
  </ol>;
}
