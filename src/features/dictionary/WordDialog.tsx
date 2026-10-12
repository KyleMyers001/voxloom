import { type FormEvent, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { validateWord } from '../../domain/dictionary';

type Props = {
  editing?: string;
  words: string[];
  opener: HTMLElement | null;
  onClose: () => void;
  onSave: (word: string, editing?: string) => void;
};

/** Add/Edit sheet (D5) with inline validation error (D6). Validation is unchanged. */
export function WordDialog({ editing, words, opener, onClose, onSave }: Props) {
  const [value, setValue] = useState(editing ?? '');
  const [error, setError] = useState('');
  const title = editing ? 'Edit dictionary word' : 'Add dictionary word';

  function save(event: FormEvent) {
    event.preventDefault();
    const result = validateWord(value, words, editing);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSave(result.word, editing);
  }

  return (
    <Dialog initialFocus="#dictionary-word" label={title} onClose={onClose} opener={opener}>
      <h2>{title}</h2>
      <form className="editor-form" onSubmit={save}>
        <label htmlFor="dictionary-word">Word</label>
        <input
          aria-describedby={error ? 'dictionary-word-error' : undefined}
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          id="dictionary-word"
          onChange={(event) => setValue(event.target.value)}
          value={value}
        />
        {error && <p className="form-error" id="dictionary-word-error" role="alert">{error}</p>}
        <div className="editor-actions">
          <button className="btn" onClick={onClose} type="button">Cancel</button>
          <button className="btn primary" type="submit">Save</button>
        </div>
      </form>
    </Dialog>
  );
}
