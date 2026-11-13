import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useApp } from '../../app/AppContext';
import { KeyCombo } from '../../components/KeyCombo';
import { initialSettings } from '../../domain/fixtures';
import { ShortcutRecorder } from '../settings/ShortcutRecorder';
import { useDogfoodCapture } from '../../services/stt/useDogfoodCapture';
import type { OwnFieldDeliveryGuard } from '../../services/stt/dogfoodPath';
import { resolveTranscriptionModelId } from '../../services/stt/resolveModelId';
import { STT_MODEL_CATALOG } from '../../services/stt/types';
import { subscribe as subscribeSettings } from '../../services/settingsWindow';
import { listenShortcutBound } from '../../services/shortcut/bindingEvents';
import { listenModelsChanged } from '../../services/stt/modelsChanged';
import { createOverlayBridge } from '../../services/shortcut';
import { createGuidedSetup, permissionsAuthorized, type PermissionKind, type SetupBoundary, type SetupProgressStorage } from './guidedSetup';
import { registerPracticeHandler, resetPracticeGestures } from './practiceBridge';
import { createSetupBoundary } from './setupBoundary';
import { SetupWindow } from './SetupWindow';
import { SETUP_STEP_TITLES, WelcomeSteps } from './WelcomeSteps';

interface OnboardingProps {
  onClose: () => void;
  opener?: HTMLElement | null;
  /** OS boundary and isolated progress store for safe component tests. */
  boundary?: SetupBoundary;
  progressStorage?: SetupProgressStorage;
}
const PROGRESS_KEY = 'voxloom.guided-setup.v1';
const localProgress: SetupProgressStorage = {
  read: () => localStorage.getItem(PROGRESS_KEY),
  write: (value) => localStorage.setItem(PROGRESS_KEY, value),
  clear: () => localStorage.removeItem(PROGRESS_KEY),
};
/** Reopening setup starts the tutorial over; Resume setup keeps unfinished progress. */
export function clearGuidedProgress(): void {
  try { localProgress.clear?.(); } catch { /* Unavailable storage has nothing to resume. */ }
}
const permissions = [
  { kind: 'microphone', key: 'microphone', title: 'Hear your voice', name: 'Microphone', copy: 'Microphone access captures your speech when you dictate.' },
  { kind: 'accessibility', key: 'accessibility', title: 'Type where you’re writing', name: 'Accessibility', copy: 'Accessibility lets Voxloom insert words into your text field. It also lets Esc cancel dictation and makes single-key shortcuts work.' },
] as const;
/** The other gesture than this try expects: say which one it wants instead of ignoring it. */
const wrongGesture = {
  hold: 'That was a double-tap. For this try, hold your shortcut, speak, then release.',
  tap: 'That was a hold. For this try, double-tap your shortcut, speak, then press it once to finish.',
} as const;

/** Do not construct the controller or expose setup actions against boot defaults. */
export function Onboarding(props: OnboardingProps) {
  const { bootReady } = useApp();
  if (!bootReady) return <SetupWindow onEscape={props.onClose} opener={props.opener}>
    <div className="setup-window__loading"><p role="status">Loading your saved setup…</p><button className="btn ghost" onClick={props.onClose} type="button">Set up later</button></div>
  </SetupWindow>;
  return <HydratedOnboarding {...props} />;
}

/** Approved B / v3: a setup spine, two permissions and two real tries in one note. */
function HydratedOnboarding({ onClose, opener, boundary, progressStorage }: OnboardingProps) {
  const { clipboard, settings, setup, state } = useApp();
  const latest = useRef(state.settings);
  latest.current = state.settings;
  const [io] = useState(() => boundary ?? createSetupBoundary());
  const [controller] = useState(() => createGuidedSetup(io,
    () => resolveTranscriptionModelId(latest.current.transcriptionModel),
    () => latest.current.shortcut, progressStorage ?? localProgress));
  const guided = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [error, setError] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const guard = useRef<OwnFieldDeliveryGuard | undefined>(undefined);
  const sequence = useRef(0);
  const pending = useRef(false);
  // A practice capture was started and has not reached a result yet.
  const capturing = useRef(false);
  const practice = useDogfoodCapture({
    clipboard, clipboardFallback: false, cleanupActive: false, ownedCaptureOnly: true,
    modelId: state.settings.transcriptionModel,
    preferredDeviceId: state.settings.microphone,
    deliveryGuard: () => guard.current,
  });
  const live = useRef(practice);
  live.current = practice;
  const busy = pending.current || ['starting', 'recording', 'transcribing', 'cleaning'].includes(practice.phase);
  const modelId = resolveTranscriptionModelId(state.settings.transcriptionModel);
  const model = STT_MODEL_CATALOG.find((item) => item.id === modelId);
  const modelLabel = model?.label ?? modelId;
  const size = model ? `${Math.round(model.sizeBytes / 1_000_000)} MB` : 'size shown in Settings';

  function cancel() {
    sequence.current++;
    pending.current = false;
    setHint(null);
    controller.cancelPractice();
    guard.current = undefined;
    // Only a live capture is cancelled: after a result, Try double-tap/Back
    // must not replace it with "Capture cancelled — nothing transcribed."
    if (capturing.current || ['starting', 'recording', 'transcribing', 'cleaning'].includes(live.current.phase)) live.current.cancel();
    capturing.current = false;
    resetPracticeGestures();
  }
  function close() { cancel(); onClose(); }
  async function action(fn: () => Promise<unknown>) {
    setError('');
    try { await fn(); } catch (e) { setError(String(e)); }
  }
  async function permission(kind: PermissionKind, settingsOnly = false) {
    await action(async () => {
      cancel();
      if (settingsOnly) await io.openSettings(kind); else await io.request(kind);
      await controller.refresh();
    });
  }

  useEffect(() => {
    heading.current?.focus();
    setup.update({ step: guided.step === 3 ? 3 : guided.step >= 2 ? 2 : 1 });
  }, [guided.step, setup]);
  useEffect(() => {
    controller.cancelPractice();
    sequence.current++;
    pending.current = false;
    if (['starting', 'recording', 'transcribing', 'cleaning'].includes(live.current.phase)) live.current.cancel();
    resetPracticeGestures();
    void controller.refresh();
  }, [controller, state.settings.transcriptionModel, state.settings.shortcut]);
  useEffect(() => {
    const recheck = () => { void controller.refresh(); };
    const onReturn = () => { if (document.visibilityState !== 'hidden') recheck(); };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    const bound = subscribeSettings(() => listenShortcutBound(recheck));
    const changed = subscribeSettings(() => listenModelsChanged(recheck));
    return () => {
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
      bound(); changed();
    };
  }, [controller]);
  useEffect(() => {
    if (!guided.downloading || guided.step === 0) return;
    const timer = window.setInterval(() => { void controller.refresh(); }, 1500);
    return () => window.clearInterval(timer);
  }, [controller, guided.downloading, guided.step]);
  useEffect(() => registerPracticeHandler((gesture) => {
    if (controller.getSnapshot().step !== 3) return;
    if (gesture === 'hold-start' || gesture === 'latch-start') {
      if (pending.current || ['starting', 'recording', 'transcribing', 'cleaning'].includes(live.current.phase)) return;
      const mode = gesture === 'hold-start' ? 'hold' : 'tap';
      const expected = controller.getSnapshot().mode;
      // A start that will not become a try must not leave the gesture machine
      // latched/holding: a stray latch would turn the next hold into its finish.
      if (mode !== expected) { setHint(wrongGesture[expected]); resetPracticeGestures(); return; }
      setHint(null);
      const own = ++sequence.current;
      pending.current = true;
      void controller.begin(mode).then(async (lease) => {
        if (!lease || own !== sequence.current) {
          if (own === sequence.current) { pending.current = false; resetPracticeGestures(); }
          return;
        }
        guard.current = {
          current: () => controller.current(lease),
          validate: async () => (await controller.refresh()) && controller.current(lease),
          insert: (text) => controller.insert(lease, text, field.current),
          result: (result) => controller.result(lease, result),
        };
        pending.current = false;
        capturing.current = true;
        await live.current.start('gesture');
      }).catch((e: unknown) => { pending.current = false; setError(String(e)); });
    } else if (gesture === 'hold-finish' || gesture === 'latch-finish') {
      if (pending.current) { sequence.current++; pending.current = false; controller.cancelPractice(); }
      else void live.current.stop().catch((e: unknown) => setError(String(e)));
    }
  }), [controller]);
  useEffect(() => {
    if (practice.phase === 'cancelled' || practice.phase === 'error' || practice.phase === 'success') {
      capturing.current = false;
      controller.cancelPractice();
      resetPracticeGestures();
    }
  }, [controller, practice.phase]);
  useEffect(() => {
    if (!io.native) return;
    const overlay = createOverlayBridge();
    overlayRef.current = overlay;
    return () => { overlayRef.current = null; void overlay.dispose(); };
  }, [controller, io]);
  const overlayRef = useRef<ReturnType<typeof createOverlayBridge> | null>(null);
  useEffect(() => {
    const phase = practice.phase;
    const visual = phase === 'transcribing' || phase === 'cleaning'
      ? { kind: 'processing' as const, completion: 'held' as const, runId: -1 }
      : phase === 'recording' || phase === 'starting'
        ? { kind: 'listening' as const, runId: -1, waveform: 'speaking' as const }
        : { kind: 'ready' as const };
    void overlayRef.current?.sync(practice.hudReady ? visual : { kind: 'ready' }, false, practice.scopeReady);
  }, [practice.phase, practice.hudReady, practice.scopeReady]);
  useEffect(() => () => { sequence.current++; controller.cancelPractice(); }, [controller]);

  const allPermissions = permissionsAuthorized(guided.permissions);
  const connected = io.native && allPermissions && guided.modelReady && !guided.checking;
  const both = guided.holdDone && guided.tapDone;
  const status = practice.phase === 'recording' ? (guided.mode === 'tap' ? 'Listening hands-free · press once to finish' : 'Listening · release to finish')
    : practice.phase === 'starting' ? 'Preparing microphone…'
      : practice.phase === 'transcribing' || practice.phase === 'cleaning' ? 'Turning speech into text…'
        : hint ?? practice.message ?? 'Ready when you are';
  const next = () => action(async () => { cancel(); await controller.next(); });
  const finish = () => action(async () => {
    if (await controller.finish()) { controller.clearProgress(); setup.update({ complete: true }); close(); }
  });
  // Explicit opt-out (parity with the pre-guided Skip): marks setup complete
  // without practice so it stops reopening at launch. Set up later stays incomplete.
  function skip() { controller.clearProgress(); setup.update({ complete: true }); close(); }

  return <SetupWindow onEscape={() => { if (pending.current || ['starting', 'recording', 'transcribing', 'cleaning'].includes(live.current.phase)) cancel(); else close(); }} opener={opener}>
    <div className="guided-setup">
      <aside className="guided-rail" aria-label="Setup progress">
        <div className="guided-brand"><span className="guided-mark" aria-hidden="true"><i /><i /><i /></span>Voxloom</div>
        <ol>{SETUP_STEP_TITLES.map((label, index) => <li aria-current={guided.step === index + 1 ? 'step' : undefined} className={guided.step > index + 1 ? 'done' : ''} key={label}><b>{guided.step > index + 1 ? '✓' : index + 1}</b><span>{label}</span></li>)}</ol>
        <div className="guided-private">PRIVATE BY DESIGN<br /><span>On-device dictation.<br />No account. No cloud model.</span></div>
      </aside>
      <div className="guided-main">
        <section className="guided-content" aria-labelledby="guided-heading" tabIndex={0}>
          <div className="guided-kicker">{['Your voice. Your Mac.', '01 / Get connected', '02 / Make it yours', '03 / First words', 'Ready for your next thought'][guided.step]}</div>
          <h2 id="guided-heading" ref={heading} tabIndex={-1}>{guided.step === 0 ? <>Less typing.<br />More you.</> : guided.step === 1 ? <>A few permissions.<br />A smoother first dictation.</> : guided.step === 2 ? <>Your shortcut.<br />Ready when you are.</> : guided.step === 3 ? both ? 'Both ways. All yours.' : guided.mode === 'tap' ? 'Now, go hands-free.' : 'First, hold to talk.' : <>You speak.<br />Voxloom types.</>}</h2>
          {guided.step === 0 && <>
            <p className="guided-intro">Speak naturally. Voxloom turns your words into text, right where you’re writing.</p>
            <WelcomeSteps shortcut={state.settings.shortcut} />

          </>}
          {guided.step === 1 && <>
            <p className="guided-intro">Two permissions connect your microphone, typing and keyboard controls. We’ll check each before moving on.</p>
            <div className="guided-permissions">{permissions.map((item) => {
              const status = guided.permissions[item.key];
              return <div className="guided-permission" key={item.kind}>
                <div><strong>{item.title}</strong><p>{item.copy}</p><small>{status === 'authorized' ? '✓ Allowed' : status === 'not-granted' ? 'Access is off or has not been granted.' : status === 'not-determined' ? 'Not requested yet.' : status === 'unknown' ? 'Checking access…' : status}</small></div>
                {status !== 'authorized' && <div className="guided-permission-actions"><button className="btn" disabled={!io.native} onClick={() => void permission(item.kind)} type="button">{item.kind === 'accessibility' ? 'Open Accessibility Settings' : `Allow ${item.name}`}</button>{status !== 'not-determined' && item.kind !== 'accessibility' && <button className="btn ghost" disabled={!io.native} onClick={() => void permission(item.kind, true)} type="button">Open {item.name} Settings</button>}</div>}
              </div>;
            })}</div>
            <p className="guided-mini">Enable Voxloom in System Settings → Privacy &amp; Security, then return and check again. If macOS asks you to quit and reopen Voxloom, do so, then resume setup. If Accessibility shows as off, Voxloom can’t tell whether access was denied or never requested.</p>
            <button className="btn ghost" onClick={() => void action(controller.refresh)} type="button">Check again</button>
            <div className="guided-pack"><strong>{guided.modelReady ? '✓ Voice pack verified · engine available' : guided.downloading ? `Downloading ${STT_MODEL_CATALOG.find((item) => item.id === guided.downloading)?.label ?? guided.downloading}…` : 'Voice pack needs attention'}</strong><span>{modelLabel} · {size}</span>
              {guided.progress && <progress aria-label="Voice pack download" max={guided.progress.bytesTotal || undefined} value={guided.progress.bytesReceived} />}
              {guided.downloading && !guided.progress && <progress aria-label="Voice pack download" />}
              {!guided.modelReady && !guided.downloading && <button className="btn" disabled={!io.native || guided.checking || guided.modelState !== 'missing'} onClick={() => void action(controller.download)} type="button">Retry download</button>}
              {guided.downloading && <button className="btn ghost" onClick={() => void action(() => io.cancelDownload(guided.downloading!))} type="button">Cancel download</button>}
              <small>One verified download, then offline dictation. Interrupted downloads restart on Retry.</small>
            </div>
            <details><summary>What happens to my voice?</summary><p>The selected speech model runs locally. The download needs internet; speech is not sent to a cloud model. Text cleanup stays off during practice.</p></details>
          </>}
          {guided.step === 2 && <>
            <p className="guided-intro">Hold these keys and talk, and Voxloom types your words where you’re writing. Keep them, or pick your own.</p>
            <ShortcutRecorder defaultValue={initialSettings.shortcut} id="onboarding-shortcut" onChange={(value) => settings.update({ key: 'shortcut', value })} value={state.settings.shortcut} variant="card" />
            <details className="guided-more"><summary>More ways to use it</summary><ul>
              <li><b>Hands-free:</b> tap your shortcut twice quickly and Voxloom keeps listening without holding. Press it once more when you’re done. You’ll try both on the next step.</li>
              <li><b>One key:</b> choose Change shortcut, then press just one key, like Right Option, Right Command or F13–F19. It uses the Accessibility access you allowed in step 1.</li>
            </ul></details>
            <p className="guided-mini guided-settings-note">You can change this later in Settings.</p>
          </>}
          {guided.step === 3 && <>
            <div className="guided-modes" aria-label="Two ways to use the same shortcut"><span aria-current={guided.mode === 'hold' ? 'step' : undefined}>{guided.holdDone ? '✓' : '1'} Hold to talk</span><span aria-current={guided.mode === 'tap' ? 'step' : undefined}>{guided.tapDone ? '✓' : '2'} Double-tap</span></div>
            <p className="guided-intro">{both ? 'You’ve tried both ways. Use whichever suits the moment.' : guided.mode === 'tap' ? 'Double-tap the same shortcut, then let go. Say a short sentence. Press the shortcut once more to finish.' : 'Click the note. Hold your shortcut, say a short sentence, then release to finish.'}</p>
            <div className="guided-note"><div><span>PRACTICE NOTE</span><span role="status">{status}</span></div><textarea aria-label="Practice dictation field" defaultValue="" placeholder={guided.mode === 'tap' ? 'Try: Now I can speak hands-free.' : 'Try: My first words with Voxloom.'} ref={field} /></div>
            <KeyCombo combo={state.settings.shortcut} />
            <p className="guided-mini">{guided.mode === 'tap' ? 'Double-tap → speak → press once to finish.' : 'Hold → speak → release.'} Esc cancels without inserting.</p>
            {!guided.ready && <p className="form-error">Check permissions, voice pack and registered shortcut before retrying.</p>}
            <div className="guided-practice-actions"><button className="btn ghost" onClick={() => { cancel(); field.current?.focus(); }} type="button">{busy ? 'Cancel dictation' : 'Try again'}</button><button className="btn ghost" onClick={() => void action(controller.refresh)} type="button">Check again</button></div>
          </>}
          {guided.step === 4 && <>
            <p className="guided-intro">You’ve tried both ways to dictate. Next, try a short sentence in an app you use.</p>
            <ul className="guided-list"><li>Microphone, typing and keyboard access {allPermissions ? 'connected' : 'need rechecking'}</li><li>{modelLabel} {guided.modelReady ? 'verified' : 'needs attention'}</li><li>Hold and double-tap both tried</li></ul>
            <div className="guided-shortcut"><KeyCombo combo={state.settings.shortcut} /><p>Hold for a quick thought. Double-tap to go hands-free. Press once more to finish.</p></div>
            <p className="guided-mini">Voxloom is available from its app window. These tries confirm the practice field, not every app or text field.</p>
            {!guided.ready && <button className="btn" onClick={() => { cancel(); controller.back(); controller.back(); controller.back(); }} type="button">Review access and voice pack</button>}
          </>}
          {(error || guided.error) && <p className="form-error" role="alert">{error || guided.error}</p>}
        </section>
        {guided.step === 0 && <p className="guided-mini guided-disclosure">{modelId === 'whisper-base.en' ? 'Starting setup downloads Whisper Base (English)' : `Starting setup prepares your selected ${modelLabel}`} ({size}) if needed. Your dictation is processed on this Mac. Larger voice packs are optional in Settings.</p>}
        <footer className="guided-footer">
          {guided.step > 0 && <button className="btn ghost" onClick={() => { cancel(); controller.back(); }} type="button">Back</button>}
          <button className="btn ghost" onClick={close} type="button">Set up later</button>
          <button className="btn ghost" onClick={skip} type="button">Skip setup</button>
          <span />
          {guided.step === 0 ? <button className="btn primary" disabled={!io.native} onClick={() => void action(controller.start)} type="button">Start setup →</button>
            : guided.step === 1 ? <button className="btn primary" disabled={!connected} onClick={() => void next()} type="button">Continue →</button>
              : guided.step === 2 ? <button className="btn primary" disabled={!guided.ready} onClick={() => void next()} type="button">Use this shortcut →</button>
                : guided.step === 3 && guided.mode === 'hold' ? <button className="btn primary" disabled={!guided.holdDone || busy} onClick={() => { cancel(); controller.tryHandsFree(); field.current?.focus(); }} type="button">Try double-tap →</button>
                  : guided.step === 3 ? <button className="btn primary" disabled={!both || !guided.ready || busy} onClick={() => void next()} type="button">Finish setup →</button>
                    : <button className="btn primary" disabled={!both || !guided.ready} onClick={() => void finish()} type="button">Open Voxloom</button>}
        </footer>
      </div>
    </div>
  </SetupWindow>;
}
