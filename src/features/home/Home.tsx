import { useApp } from '../../app/AppContext';
import type { WritingStyle } from '../../domain/types';
import { isTauriEnv } from '../../services/capture/captureService';
import type { UseDogfoodCaptureResult } from
  '../../services/stt/useDogfoodCapture';

interface HomeProps {
  /** Shared App-level dogfood capture (also driven by global gesture). */
  dogfood: UseDogfoodCaptureResult;
  onToast: (message: string) => void;
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestamp);
}

export function Home({ dogfood, onToast }: HomeProps) {
  const { clipboard, dispatch, settings, state } = useApp();
  const recent = [...state.records]
    .filter(({ status }) => status !== 'failed')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 5);

  const isNative = isTauriEnv();
  const recording = dogfood.phase === 'recording'
    || dogfood.captureState.kind === 'active';
  const busy = dogfood.phase === 'transcribing';

  async function copy(text: string) {
    try {
      await clipboard.copy(text);
      onToast('Copied to clipboard');
    } catch {
      onToast('Copy failed');
    }
  }

  return (
    <section aria-labelledby="home-title">
      <div className="hero">
        <div>
          <h2 id="home-title">
            {isNative ? 'Style preference · cleanup not available' : 'Writing style'}
          </h2>
          <div aria-label="Current writing style" className="style-switch">
            {(['formal', 'casual', 'very-casual'] as WritingStyle[])
              .map((style) => (
                <button
                  aria-pressed={state.settings.style === style}
                  key={style}
                  onClick={() => settings.update({
                    key: 'style',
                    value: style,
                  })}
                >
                  {style === 'very-casual' ? 'Very Casual' :
                    `${style[0].toUpperCase()}${style.slice(1)}`}
                </button>
              ))}
          </div>
        </div>
      </div>

      <div className="card" aria-labelledby="capture-title">
        <div className="card__head">
          <h2 id="capture-title">Dictate</h2>
        </div>
        <p className="empty-note">
          Full capture → selected Settings model → insert into the
          intended app when possible, otherwise Copy (clipboard fallback
          toggle in Settings). Stop deposits audio and runs STT
          automatically; Cancel discards with no transcription.
          For Notes <strong>Inserted</strong>, use the global hold/latch
          while Notes is focused — Home Start focuses Voxloom first and
          may honestly <strong>Copy</strong>.
        </p>
        {!isNative && (
          <p className="form-error" role="status">
            Native capture requires the Tauri shell (Mac smoke).
          </p>
        )}
        <div className="action-group dogfood-capture-actions">
          {!recording && !busy && (
            <button
              className="btn accent"
              disabled={!isNative || busy}
              onClick={() => { void dogfood.start(); }}
              type="button"
            >
              Start capture
            </button>
          )}
          {recording && (
            <>
              <button
                className="btn accent"
                disabled={busy}
                onClick={() => { void dogfood.stop(); }}
                type="button"
              >
                Stop
              </button>
              <button
                className="quiet-button"
                disabled={busy}
                onClick={() => dogfood.cancel()}
                type="button"
              >
                Cancel
              </button>
            </>
          )}
          {busy && (
            <span className="empty-note" role="status">Transcribing…</span>
          )}
        </div>
        {dogfood.message && (
          <p
            className={
              dogfood.phase === 'error' || dogfood.phase === 'cancelled'
                ? 'form-error'
                : 'empty-note'
            }
            data-phase={dogfood.phase}
            role="status"
          >
            {dogfood.message}
          </p>
        )}
        {dogfood.transcript?.text && (
          <div className="dogfood-transcript" aria-live="polite">
            <h3 className="dogfood-transcript__label">Last transcript</h3>
            <p>{dogfood.transcript.text}</p>
            <p className="empty-note">
              Manual recovery available even when History retention is off.
            </p>
            <button
              className="quiet-button"
              onClick={() => { void copy(dogfood.transcript!.text); }}
              type="button"
            >
              Copy last transcript
            </button>
          </div>
        )}
        <p className="empty-note">
          Model: {state.settings.transcriptionModel}
        </p>
      </div>

      <div className="card">
        <div className="card__head">
          <h2>Recent dictations</h2>
          <button
            className="quiet-button"
            onClick={() => dispatch({ screen: 'history', type: 'set-screen' })}
          >
            View all →
          </button>
        </div>
        <div className="recent-list">
          {recent.map((record) => (
            <div className="recent-row" key={record.id}>
              <span className="timestamp">{formatTime(record.createdAt)}</span>
              <p>{record.text}</p>
              <button
                aria-label="Copy dictation"
                className="action-btn icon-btn"
                onClick={() => void copy(record.text)}
                title="Copy dictation"
              >
                ⧉
              </button>
            </div>
          ))}
          {!recent.length && <p className="empty-note">No dictations yet.</p>}
        </div>
      </div>
    </section>
  );
}
