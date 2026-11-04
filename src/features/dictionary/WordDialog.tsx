import { type FormEvent, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { validateWord } from '../../domain/dictionary';
import {
  type DictionaryAliases,
  validateAliases,
  validateWordAgainstAliases,
} from '../../services/dictionary/aliases';

type Props = {
  aliases: DictionaryAliases;
  editing?: string;
  words: string[];
  opener: HTMLElement | null;
  onClose: () => void;
  onSave: (word: string, editing: string | undefined, aliases: string[]) => void;
};

/**
 * Add/Edit sheet (D5) with inline validation errors (D6): the word, and the
 * optional comma-separated "Also heard as" spellings (BUS-138).
 */
export function WordDialog({ aliases, editing, words, opener, onClose, onSave }: Props) {
  const [value, setValue] = useState(editing ?? '');
  const [heard, setHeard] = useState((editing && aliases[editing] ? aliases[editing] : []).join(', '));
  const [error, setError] = useState('');
  const [heardError, setHeardError] = useState('');
  const title = editing ? 'Edit dictionary word' : 'Add dictionary word';

  function save(event: FormEvent) {
    event.preventDefault();
    const result = validateWord(value, words, editing);
    const word = result.ok ? validateWordAgainstAliases(result.word, aliases, editing) : result;
    const heardResult = validateAliases(heard, value.trim(), words, aliases, editing);
    setError(word.ok ? '' : word.error);
    setHeardError(heardResult.ok ? '' : heardResult.error);
    if (result.ok && word.ok && heardResult.ok) onSave(result.word, editing, heardResult.aliases);
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
        <label htmlFor="dictionary-aliases">Also heard as (optional)</label>
        <input
          aria-describedby={`dictionary-aliases-hint${heardError ? ' dictionary-aliases-error' : ''}`}
          aria-invalid={heardError ? true : undefined}
          autoComplete="off"
          id="dictionary-aliases"
          onChange={(event) => setHeard(event.target.value)}
          value={heard}
        />
        <p className="empty-note" id="dictionary-aliases-hint">
          Separate with commas. Example: box loom, vox loom
        </p>
        {heardError && (
          <p className="form-error" id="dictionary-aliases-error" role="alert">{heardError}</p>
        )}
        <div className="editor-actions">
          <button className="btn" onClick={onClose} type="button">Cancel</button>
          <button className="btn primary" type="submit">Save</button>
        </div>
      </form>
    </Dialog>
  );
}
