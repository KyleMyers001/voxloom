import { useEffect, useState } from 'react';
import { useApp } from '../../app/AppContext';
import { canStartDictation } from '../../app/state';
import { canRetry } from '../../domain/records';
import { isTauriEnv } from '../../services/capture/captureService';
import type { HistoryStatus } from '../../domain/types';

interface HistoryProps {
  onToast: (message: string) => void;
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestamp);
}

export function History({ onToast }: HistoryProps) {
  const { clipboard, dictation, history, now, state } = useApp();
  const isNative = isTauriEnv();
  const [currentTime, setCurrentTime] = useState(now);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<HistoryStatus | 'all'>('all');
  const records = [...state.records]
    .filter((record) => status === 'all' || record.status === status)
    .filter((record) => record.text.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => b.createdAt - a.createdAt);

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(now()), 1_000);
    return () => window.clearInterval(timer);
  }, [now]);

  async function copy(text: string) {
    try {
      await clipboard.copy(text);
      onToast('Copied to clipboard');
    } catch {
      onToast('Copy failed');
    }
  }

  function retry(record: (typeof records)[number]) {
    if (!canStartDictation(state.dictation)) {
      onToast('Finish the current dictation before retrying');
      return;
    }
    if (!canRetry(record, now())) {
      setCurrentTime(now());
      onToast('Recovery buffer expired');
      return;
    }
    dictation.retry(record.id);
  }

  return (
    <section aria-labelledby="history-title">
      <div className="hero">
        <div>
          <h1 id="history-title">History</h1>
          <p>Transcript storage follows Settings → retention. Audio retry is not available in the desktop app.</p>
        </div>
      </div>
      <div className="card">
        <div className="search-row">
          <input
            aria-label="Search history"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search transcripts"
            type="search"
            value={query}
          />
          <select
            aria-label="History status"
            onChange={(event) => setStatus(
              event.target.value as HistoryStatus | 'all'
            )}
            value={status}
          >
            <option value="all">All statuses</option>
            <option value="inserted">Inserted</option>
            <option value="copied">Copied</option>
            <option value="failed">Failed</option>
          </select>
        </div>
        <div className="history-list">
          {records.map((record) => (
            <article className="recent-row" key={record.id} tabIndex={0}>
              <span className="timestamp">{formatTime(record.createdAt)}</span>
              <div>
                <h3>{record.text}</h3>
                <p className="empty-note">
                  {record.durationSeconds}s · {record.status[0].toUpperCase()}
                  {record.status.slice(1)} · {
                    record.model ?? 'Local STT'
                  } · {
                    record.style === 'very-casual' ? 'Very Casual' :
                      `${record.style[0].toUpperCase()}${record.style.slice(1)}`
                  }
                </p>
                {record.cleanup && record.cleanup.promptVersion !== 'legacy-v1' && (
                  <p className="empty-note">
                    Cleanup: {record.cleanup.status}
                    {record.cleanup.reason
                      ? ` (${record.cleanup.reason})`
                      : ''}
                  </p>
                )}
                {record.rawText && record.rawText !== record.text && (
                  <details>
                    <summary>Show raw transcript</summary>
                    <p>{record.rawText}</p>
                  </details>
                )}
                {record.status === 'failed' && (
                  <p className="recovery-state">
                    {isNative
                      ? 'No audio retry available; copy the text to recover it.'
                      : canRetry(record, currentTime) && record.recoveryExpiresAt
                        ? `Temporary recovery buffer · expires ${
                          formatTime(record.recoveryExpiresAt)}`
                        : 'Temporary recovery buffer expired'}
                  </p>
                )}
              </div>
              <div className="action-group">
                {record.text.trim() && (
                  <button
                    aria-label="Copy transcript"
                    className="action-btn icon-btn"
                    onClick={() => void copy(record.text)}
                    title="Copy transcript"
                  >⧉</button>
                )}
                {!isNative && canRetry(record, currentTime) && (
                  <button
                    aria-label="Retry transcription"
                    className="action-btn icon-btn"
                    disabled={!canStartDictation(state.dictation)}
                    onClick={() => retry(record)}
                    title="Retry transcription"
                  >↻</button>
                )}
                <button
                  aria-label="Delete transcript"
                  className="action-btn danger icon-btn"
                  onClick={() => history.delete(record.id)}
                  title="Delete transcript"
                >⌫</button>
              </div>
            </article>
          ))}
          {!records.length && (
            <p className="empty-note">No history matches these filters.</p>
          )}
        </div>
      </div>
    </section>
  );
}
