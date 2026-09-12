import { useState } from "react";
import { useApp } from "../../app/AppContext";
import { canRetry } from "../../domain/records";
import type { HistoryStatus } from "../../domain/types";

interface HistoryProps {
  onToast: (message: string) => void;
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

export function History({ onToast }: HistoryProps) {
  const { clipboard, dispatch, now, state } = useApp();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<HistoryStatus | "all">("all");
  const records = [...state.records]
    .filter((record) => status === "all" || record.status === status)
    .filter((record) => record.text.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => b.createdAt - a.createdAt);

  async function copy(text: string) {
    try {
      await clipboard.copy(text);
      onToast("Copied to clipboard");
    } catch {
      onToast("Copy failed");
    }
  }

  return (
    <section aria-labelledby="history-title">
      <div className="hero">
        <div>
          <h1 id="history-title">History</h1>
          <p>Transcripts stay in this session. Audio retention is off.</p>
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
              event.target.value as HistoryStatus | "all"
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
                  {record.durationSeconds}s · {record.status} · Pine Voice
                  Small · {record.style}
                </p>
              </div>
              <div className="action-group">
                {record.status !== "failed" && (
                  <button
                    aria-label="Copy transcript"
                    className="action-btn icon-btn"
                    onClick={() => void copy(record.text)}
                    title="Copy transcript"
                  >⧉</button>
                )}
                {canRetry(record, now()) && (
                  <button
                    aria-label="Retry transcription"
                    className="action-btn icon-btn"
                    onClick={() => dispatch({
                      id: record.id,
                      now: now(),
                      type: "retry",
                    })}
                    title="Retry transcription"
                  >↻</button>
                )}
                <button
                  aria-label="Delete transcript"
                  className="action-btn danger icon-btn"
                  onClick={() => dispatch({
                    id: record.id,
                    type: "delete-record",
                  })}
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
