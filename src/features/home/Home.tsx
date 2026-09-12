import { useApp } from "../../app/AppContext";
import type { WritingStyle } from "../../domain/types";

interface HomeProps {
  onToast: (message: string) => void;
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

export function Home({ onToast }: HomeProps) {
  const { clipboard, dispatch, state } = useApp();
  const recent = [...state.records]
    .filter(({ status }) => status !== "failed")
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 5);

  async function copy(text: string) {
    try {
      await clipboard.copy(text);
      onToast("Copied to clipboard");
    } catch {
      onToast("Copy failed");
    }
  }

  return (
    <section aria-labelledby="home-title">
      <div className="hero">
        <div>
          <h1 id="home-title">Writing style</h1>
          <div aria-label="Current writing style" className="style-switch">
            {(["formal", "casual", "very-casual"] as WritingStyle[])
              .map((style) => (
                <button
                  aria-pressed={state.settings.style === style}
                  key={style}
                  onClick={() => dispatch({
                    key: "style",
                    type: "set-setting",
                    value: style,
                  })}
                >
                  {style === "very-casual" ? "Very Casual" :
                    `${style[0].toUpperCase()}${style.slice(1)}`}
                </button>
              ))}
          </div>
        </div>
      </div>
      <div className="card">
        <div className="card__head">
          <h2>Recent dictations</h2>
          <button
            className="quiet-button"
            onClick={() => dispatch({ screen: "history", type: "set-screen" })}
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
