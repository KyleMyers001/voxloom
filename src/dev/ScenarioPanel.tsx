import { useApp } from '../app/AppContext';

export type OnboardingScenario = 'collision' | 'permission-denied';

interface ScenarioPanelProps {
  onOnboarding: (scenario: OnboardingScenario) => void;
  onReset: () => void;
}

export function ScenarioPanel({
  onOnboarding,
  onReset,
}: ScenarioPanelProps) {
  const { dictation, dispatch, now, state } = useApp();
  const runId = 'runId' in state.dictation ? state.dictation.runId : null;

  return (
    <section aria-label="Development scenarios" className="state-lab">
      <strong>Dev · mock scenarios</strong>
      <button onClick={onReset}>
        Reset session
      </button>
      <button onClick={onReset}>First-run setup</button>
      <button onClick={() => onOnboarding('collision')}>
        Shortcut collision
      </button>
      <button onClick={() => dispatch({ type: 'scenario-empty' })}>
        Empty lists
      </button>
      <button onClick={dictation.start}>
        Listening · silent
      </button>
      <button onClick={() => {
        dictation.start();
        dictation.speech('speaking');
      }}>Listening · speaking</button>
      <button disabled={runId === null} onClick={() => runId !== null &&
        dictation.holdProcessing(runId)}>Processing</button>
      <button disabled={runId === null} onClick={() => runId !== null &&
        dictation.complete(runId)}>
        Complete success
      </button>
      <button disabled={runId === null} onClick={() => runId !== null &&
        dictation.fail(runId)}>
        Complete error
      </button>
      <button disabled={runId === null} onClick={() => runId !== null &&
        dictation.cancel(runId)}>
        Cancel
      </button>
      <button onClick={() => dispatch({ now: now(), type: 'expire-recovery' })}>
        Expire recovery buffers
      </button>
      <label className="check">
        <input checked={state.clipboardFailure} onChange={(event) => dispatch({
          type: 'set-clipboard-failure',
          value: event.target.checked,
        })} type="checkbox" />
        Copy failure
      </label>
      <button onClick={() => onOnboarding('permission-denied')}>
        Permission denied
      </button>
      <p>
        Controls are synthetic. No audio or OS capability is used.
        With durable history on, Reset asks before wiping{' '}
        <code>history.json</code>.
      </p>
    </section>
  );
}
