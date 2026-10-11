import { useApp } from '../../app/AppContext';
import { Badge } from '../../components/Badge';
import { EmptyState } from '../../components/EmptyState';
import { IconButton } from '../../components/IconButton';

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(timestamp);
}

/** Five most recent non-failed dictations with status badge + copy (H9–H11). */
export function RecentCard({ onCopy }: { onCopy: (text: string) => void }) {
  const { dispatch, state } = useApp();
  const recent = [...state.records]
    .filter(({ status }) => status !== 'failed')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 5);

  return (
    <section aria-labelledby="recent-title" className="card home-card">
      <div className="card__head">
        <h2 id="recent-title">Recent dictations</h2>
        <button className="link-button" onClick={() => dispatch({ screen: 'history', type: 'set-screen' })} type="button">
          View all →
        </button>
      </div>
      <div className="recent-list">
        {recent.map((record) => (
          <div className="recent-row" key={record.id}>
            <span className="timestamp">{formatTime(record.createdAt)}</span>
            <p>{record.text}</p>
            <Badge status={record.status} />
            <IconButton icon="copy" label="Copy dictation" onClick={() => onCopy(record.text)} />
          </div>
        ))}
        {!recent.length && <EmptyState compact icon="clock" title="No dictations yet." />}
      </div>
    </section>
  );
}
