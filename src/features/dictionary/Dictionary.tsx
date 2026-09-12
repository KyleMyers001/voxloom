import { type FormEvent, useRef, useState } from "react";
import { useApp } from "../../app/AppContext";
import { Dialog } from "../../components/Dialog";
import { validateWord } from "../../domain/dictionary";

export function Dictionary() {
  const { dispatch, state } = useApp();
  const [editing, setEditing] = useState<string>();
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [value, setValue] = useState("");
  const opener = useRef<HTMLElement | null>(null);
  const words = state.words.filter((word) =>
    word.toLowerCase().includes(query.toLowerCase())
  );

  function edit(word: string | undefined, element: HTMLElement) {
    opener.current = element;
    setEditing(word);
    setError("");
    setOpen(true);
    setValue(word ?? "");
  }

  function save(event: FormEvent) {
    event.preventDefault();
    const result = validateWord(value, state.words, editing);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    dispatch({ editing, type: "save-word", word: result.word });
    setOpen(false);
  }

  return (
    <section aria-labelledby="dictionary-title">
      <div className="hero">
        <div>
          <h1 id="dictionary-title">Dictionary</h1>
          <p>Canonical words used during simulated local transcription.</p>
        </div>
        <button
          className="btn accent"
          onClick={(event) => edit(undefined, event.currentTarget)}
        >
          Add term
        </button>
      </div>
      <div className="card">
        <div className="search-row">
          <input
            aria-label="Search dictionary"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search words"
            type="search"
            value={query}
          />
        </div>
        <div className="term-list">
          {words.map((word) => (
            <div className="term-row" key={word} tabIndex={0}>
              <strong>{word}</strong>
              <div className="action-group term-row__actions">
                <button
                  aria-label={`Edit ${word}`}
                  className="action-btn icon-btn"
                  onClick={(event) => edit(word, event.currentTarget)}
                >✎</button>
                <button
                  aria-label={`Delete ${word}`}
                  className="action-btn danger icon-btn"
                  onClick={() => dispatch({ type: "delete-word", word })}
                >×</button>
              </div>
            </div>
          ))}
          {!words.length && <p className="empty-note">No words found.</p>}
        </div>
      </div>
      {open && (
        <Dialog
          label={editing ? "Edit dictionary word" : "Add dictionary word"}
          onClose={() => setOpen(false)}
          opener={opener.current}
        >
          <h2>{editing ? "Edit dictionary word" : "Add dictionary word"}</h2>
          <form className="editor-form" onSubmit={save}>
            <label htmlFor="dictionary-word">Word</label>
            <input
              autoComplete="off"
              id="dictionary-word"
              onChange={(event) => setValue(event.target.value)}
              value={value}
            />
            {error && <p className="form-error" role="alert">{error}</p>}
            <div className="editor-actions">
              <button className="btn" onClick={() => setOpen(false)}
                type="button">Cancel</button>
              <button className="btn accent" type="submit">Save</button>
            </div>
          </form>
        </Dialog>
      )}
    </section>
  );
}
