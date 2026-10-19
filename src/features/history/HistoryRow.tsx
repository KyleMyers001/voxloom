import { useState } from 'react';
import { Badge } from '../../components/Badge';
import { Icon } from '../../components/Icon';
import { IconButton } from '../../components/IconButton';
import { canRetry } from '../../domain/records';
import type { DictationRecord } from '../../domain/types';
import { cleanupLabel } from './cleanupProvenance';

export function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(timestamp);
}

const styleLabel = (style: DictationRecord['style']) =>
  style === 'very-casual' ? 'Very Casual' : `${style[0].toUpperCase()}${style.slice(1)}`;

type Props = {
  record: DictationRecord;
  isNative: boolean;
  currentTime: number;
  canStart: boolean;
  onCopy: (text: string) => void;
  onRetry: (record: DictationRecord) => void;
  onDelete: (id: string) => void;
};

/** One History row: time · text · badge + meta · amber note · Copy / Retry (browser) / Delete. */
export function HistoryRow({ record, isNative, currentTime, canStart, onCopy, onRetry, onDelete }: Props) {
  const textId = `history-text-${record.id}`;
  const retryable = !isNative && canRetry(record, currentTime);
  const failedNote = isNative
    ? 'No audio retry available; copy the text to recover it.'
    : retryable && record.recoveryExpiresAt
      ? `Temporary recovery buffer · expires ${formatTime(record.recoveryExpiresAt)}`
      : 'Temporary recovery buffer expired';
  const note = record.mayHaveInserted
    ? `May have been inserted${record.mayHaveInserted.copied ? ' (also copied)' : ''}. Check the field before copying or retrying.`
    : record.status === 'unverified'
    ? 'Terminal input not verified. Inspect before copying or retrying.'
    : record.status === 'failed' ? failedNote : null;

  const [originalOpen, setOriginalOpen] = useState(false);
  const hasText = Boolean(record.text.trim());
  const cleanup = cleanupLabel(record.cleanup);
  // Only a cleaned row has a different original worth showing; other rows'
  // rawText is the Whisper output before the built-in tag cleanup.
  const original = record.cleanup?.status === 'cleaned' && record.rawText
    && record.rawText !== record.text ? record.rawText : null;
  return (
    <article className="recent-row history-row" data-status={record.status} tabIndex={0}>
      <span className="timestamp">{formatTime(record.createdAt)}</span>
      <div className="history-row__body">
        <h2 className="history-row__text" id={textId}>{record.text}</h2>
        <p className="history-row__meta">
          <Badge status={record.status} />
          <span>{record.durationSeconds}s · {record.model ?? 'Local STT'} · {styleLabel(record.style)}</span>
          {cleanup && <span className="history-row__cleanup">· {cleanup}</span>}
        </p>
        {original && (
          <details className="history-row__original" onToggle={(event) => setOriginalOpen(event.currentTarget.open)}>
            <summary>{originalOpen ? 'Hide original' : 'Show original'}</summary>
            <p>{original}</p>
          </details>
        )}
        {note && (
          <p className="recovery-state">
            <Icon name="warn" size={13} /> {note}
          </p>
        )}
      </div>
      <div aria-label="Transcript actions" className="action-group" role="group">
        {/* Only the first action is described by the transcript, so VoiceOver reads it once. */}
        {hasText && (
          <IconButton icon="copy" aria-describedby={textId} label="Copy transcript" onClick={() => onCopy(record.text)} />
        )}
        {retryable && (
          <IconButton disabled={!canStart} icon="retry" aria-describedby={hasText ? undefined : textId} label="Retry transcription" onClick={() => onRetry(record)} />
        )}
        <IconButton icon="trash" aria-describedby={hasText || retryable ? undefined : textId} label="Delete transcript" onClick={() => onDelete(record.id)} tone="danger" />
      </div>
    </article>
  );
}
