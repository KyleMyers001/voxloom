import { useApp } from "../app/AppContext";

export function ScenarioPanel() {
  const { dispatch, now, state } = useApp();
  const runId = "runId" in state.dictation ? state.dictation.runId : null;

  return (
    <section aria-label="Development scenarios" className="state-lab">
      <strong>Dev · mock scenarios</strong>
      <button onClick={() => dispatch({ now: now(), type: "reset" })}>
        Reset session
      </button>
      <button onClick={() => dispatch({ type: "scenario-empty" })}>
        Empty lists
      </button>
      <button onClick={() => dispatch({ type: "start-dictation" })}>
        Listening · silent
      </button>
      <button onClick={() => {
        dispatch({ type: "start-dictation" });
        dispatch({ type: "set-waveform", value: "speaking" });
      }}>Listening · speaking</button>
      <button disabled={runId === null} onClick={() => runId !== null &&
        dispatch({ runId, type: "process-dictation" })}>Processing</button>
      <button disabled={runId === null} onClick={() => runId !== null &&
        dispatch({ now: now(), runId, type: "complete-dictation" })}>
        Complete success
      </button>
      <button disabled={runId === null} onClick={() => runId !== null &&
        dispatch({ now: now(), runId, type: "fail-dictation" })}>
        Complete error
      </button>
      <button onClick={() => dispatch({ type: "cancel-dictation" })}>
        Cancel
      </button>
      <button onClick={() => dispatch({ now: now(), type: "expire-recovery" })}>
        Expire recovery buffers
      </button>
      <label className="check">
        <input checked={state.clipboardFailure} onChange={(event) => dispatch({
          type: "set-clipboard-failure",
          value: event.target.checked,
        })} type="checkbox" />
        Copy failure
      </label>
      <button onClick={() => dispatch({
        type: "set-onboarding",
        value: {
          ...state.onboarding,
          microphoneGranted: false,
          permissionDenied: true,
        },
      })}>Permission denied</button>
      <p>Controls are synthetic. No audio or OS capability is used.</p>
    </section>
  );
}
