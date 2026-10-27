import { Badge, type BadgeStatus } from '../../components/Badge';
import { Icon } from '../../components/Icon';
import { ProgressBar } from '../../components/ProgressBar';
import type { SttDownloadProgress, SttModelInfo } from '../../services/stt/types';

const mb = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;

type Props = {
  model: SttModelInfo;
  selected: boolean;
  progress: SttDownloadProgress | null;
  failure: string | undefined;
  onSelect: () => void;
  onDownload: () => void;
  onCancel: () => void;
  /** BUS-52: another model is downloading; only one download runs at a time. */
  downloadLocked?: boolean;
};

/** One model card (M3–M5, M7): radio + label, id · size, status badge, and its action. */
export function ModelCard({ model, selected, progress, failure, onSelect, onDownload, onCancel, downloadLocked = false }: Props) {
  const downloading = model.status === 'downloading' || progress !== null;
  const failed = !downloading && model.status !== 'available' && (failure !== undefined || model.status === 'failed');
  const status: BadgeStatus = downloading ? 'downloading' : failed ? 'failed' : model.status === 'available' ? 'available' : 'missing';
  const errorId = `stt-model-error-${model.id}`;
  const pct = progress ? Math.round(progress.ratio * 100) : 0;
  const total = progress?.bytesTotal || model.sizeBytes;
  const lockNoteId = `stt-model-lock-${model.id}`;
  const lock = downloadLocked ? { 'aria-describedby': lockNoteId, disabled: true } : {};

  return (
    <li className="stt-model-row" data-selected={selected || undefined}>
      <label className="stt-model-select">
        <input checked={selected} name="stt-model" onChange={onSelect} type="radio" value={model.id} />
        <span>
          <strong>{model.label}</strong>
          <span className="stt-model-id"><span>{model.id}</span> · <span className="stt-model-size">{mb(model.sizeBytes)}</span></span>
        </span>
      </label>
      <Badge status={status} />
      <div className="stt-model-actions">
        {downloading ? (
          <>
            <ProgressBar
              caption={progress ? `${pct}% · ${Math.round(progress.bytesReceived / 1_000_000)} of ${mb(total)}` : 'Downloading…'}
              label={`Downloading ${model.label}`}
              value={progress ? pct : null}
            />
            {/* BUS-76: not yet registered natively, so Cancel would silently do nothing. */}
            {!model.pending && <button className="btn" onClick={onCancel} type="button">Cancel download</button>}
          </>
        ) : model.status === 'available' ? null : failed ? (
          <button aria-describedby={downloadLocked ? `${errorId} ${lockNoteId}` : errorId} className={downloadLocked ? 'btn' : 'btn primary'} disabled={downloadLocked} onClick={onDownload} type="button">
            <Icon name="retry" size={14} />
            Retry download
          </button>
        ) : (
          <button className="btn" onClick={onDownload} type="button" {...lock}>
            <Icon name="download" size={14} />
            Download
          </button>
        )}
      </div>
      {failed && (
        <p className="form-error stt-model-error" id={errorId} role="alert">
          {failure ?? 'Model file is damaged. Download it again.'}
        </p>
      )}
      {downloadLocked && !downloading && model.status !== 'available' && (
        <p className="empty-note stt-model-lock-note" id={lockNoteId}>Available after the current download.</p>
      )}
      {selected && (
        <p className="empty-note stt-model-selected-note">
          Selected for transcription
          {model.status !== 'available' ? ' · download required before dictating' : ''}
        </p>
      )}
    </li>
  );
}
