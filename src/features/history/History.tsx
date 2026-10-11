import { useEffect, useState } from 'react';
import { useApp } from '../../app/AppContext';
import { canStartDictation } from '../../app/state';
import { EmptyState } from '../../components/EmptyState';
import { SearchField } from '../../components/SearchField';
import { SegmentedControl } from '../../components/SegmentedControl';
import { canRetry } from '../../domain/records';
import type { DictationRecord, HistoryStatus, Settings } from '../../domain/types';
import { isTauriEnv } from '../../services/capture/captureService';
import { HistoryRow } from './HistoryRow';

interface HistoryProps {
  onToast: (message: string) => void;
}

type Filter = HistoryStatus | 'all';

const filters: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'inserted', label: 'Inserted' },
  { value: 'copied', label: 'Copied' },
  { value: 'failed', label: 'Failed' },
  { value: 'unverified', label: 'Unverified' },
];

const retentionCopy: Record<Settings['transcriptRetention'], string> = {
  '30-days': 'Kept for 30 days (Settings › Retention & privacy).',
  forever: 'Kept until you delete them (Settings › Retention & privacy).',
  off: 'Transcript retention is off (Settings › Retention & privacy).',
};

export function History({ onToast }: HistoryProps) {
  const { clipboard, dictation, history, now, state } = useApp();
  const isNative = isTauriEnv();
  const [currentTime, setCurrentTime] = useState(now);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<Filter>('all');
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

  function retry(record: DictationRecord) {
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
    <section aria-labelledby="history-title" className="history">
      <header className="page-head">
        <h1 id="history-title">History</h1>
        <p>
          {retentionCopy[state.settings.transcriptRetention]}{' '}
          {isNative
            ? 'Audio isn’t saved, so audio retry isn’t available in the desktop app.'
            : 'Failed dictations can be retried while their temporary recovery buffer lasts.'}
        </p>
      </header>
      <div className="history-tools">
        <SearchField label="Search history" onChange={setQuery} placeholder="Search transcripts" value={query} />
        <SegmentedControl label="History status" onChange={setStatus} options={filters} size="sm" value={status} />
      </div>
      <div className="history-list card">
        {records.map((record) => (
          <HistoryRow
            canStart={canStartDictation(state.dictation)}
            currentTime={currentTime}
            isNative={isNative}
            key={record.id}
            onCopy={(text) => { void copy(text); }}
            onDelete={(id) => history.delete(id)}
            onRetry={retry}
            record={record}
          />
        ))}
        {!state.records.length && (
          <EmptyState icon="clock" title="No dictations yet">
            Hold the shortcut in any app to dictate. Transcripts appear here.
          </EmptyState>
        )}
        {state.records.length > 0 && !records.length && (
          <EmptyState icon="search" title="No history matches these filters">
            Clear the search or choose All.
          </EmptyState>
        )}
      </div>
    </section>
  );
}
