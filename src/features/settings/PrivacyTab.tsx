import { useApp } from '../../app/AppContext';
import { SegmentedControl } from '../../components/SegmentedControl';
import { audioRetentions, parseChoice } from '../../domain/settings';
import type { Settings } from '../../domain/types';
import { isTauriEnv } from '../../services/capture/captureService';

const transcriptOptions: { value: Settings['transcriptRetention']; label: string }[] = [
  { value: '30-days', label: '30 days' },
  { value: 'forever', label: 'Until deleted' },
  { value: 'off', label: 'Off' },
];

/** Privacy & Recovery tab (R1–R3, E1). */
export function PrivacyTab() {
  const { settings, state } = useApp();
  const isNative = isTauriEnv();
  const recovery: [string, string][] = [
    ['Microphone denied', 'Enable in System Settings › Privacy & Security › Microphone.'],
    ['Shortcut collision', 'Choose another combo; your prior binding is kept.'],
    ['Model unavailable', 'Download a speech-to-text model in Models.'],
    ['No audio activity detected', 'No transcript is created.'],
    ['Insertion failed', 'The clipboard result is reported truthfully.'],
    ['Transcription failed', isNative
      ? 'No audio retry is available; copy any surviving transcript.'
      : 'Temporary recovery buffers expire.'],
  ];

  return (
    <>
      <div className="settings-rows">
        <div className="frow">
          <span className="frow__label">
            <span id="transcript-retention-label">Transcript retention</span>
            <small className="frow__help" id="transcript-retention-help">
              Off keeps no transcripts. Home still shows the last one for manual recovery.
            </small>
          </span>
          <SegmentedControl
            label="Transcript retention"
            onChange={(value) => settings.update({ key: 'transcriptRetention', value })}
            options={transcriptOptions}
            size="sm"
            value={state.settings.transcriptRetention}
          />
        </div>
        <div className="frow">
          <span className="frow__label">
            <label htmlFor="audio-retention">Audio retention</label>
            {isNative && <span className="tag">No saved audio in desktop</span>}
          </span>
          <select
            disabled={isNative}
            id="audio-retention"
            onChange={(event) => settings.update({
              key: 'audioRetention',
              value: parseChoice(event.target.value, audioRetentions),
            })}
            value={isNative ? 'off' : state.settings.audioRetention}
          >
            <option value="off">Off · recommended</option>
            <option value="24-hours">24 hours</option>
            <option value="7-days">7 days</option>
          </select>
        </div>
      </div>
      <div className="callout">
        <b>Stays on this Mac</b>
        <p>
          Audio is captured locally and not stored. No audio or transcript is sent to a
          remote service. Models download only when you ask. The global shortcut
          registers, or reverts to the last working one if there’s a conflict
          (register-or-revert).
        </p>
      </div>
      <h3 className="settings-subhead">If something goes wrong</h3>
      <div className="recovery-grid">
        {recovery.map(([title, body]) => (
          <p className="recovery-item" key={title}><b>{title}</b> · {body}</p>
        ))}
      </div>
    </>
  );
}
