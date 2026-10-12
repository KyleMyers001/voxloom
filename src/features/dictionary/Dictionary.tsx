import { useRef, useState } from 'react';
import { useApp } from '../../app/AppContext';
import { EmptyState } from '../../components/EmptyState';
import { Icon } from '../../components/Icon';
import { IconButton } from '../../components/IconButton';
import { SearchField } from '../../components/SearchField';
import { WordDialog } from './WordDialog';

const count = (n: number) => `${n} ${n === 1 ? 'word' : 'words'}`;

export function Dictionary() {
  const { dictionary, state } = useApp();
  const [editing, setEditing] = useState<string>();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const opener = useRef<HTMLElement | null>(null);
  const words = state.words.filter((word) =>
    word.toLowerCase().includes(query.toLowerCase())
  );

  function edit(word: string | undefined, element: HTMLElement) {
    opener.current = element;
    setEditing(word);
    setOpen(true);
  }

  return (
    <section aria-labelledby="dictionary-title" className="dictionary">
      <header className="page-head page-head--action">
        <div>
          <h1 id="dictionary-title">Dictionary</h1>
          <p>Your canonical spellings for names and terms.</p>
        </div>
        <button className="btn primary" onClick={(event) => edit(undefined, event.currentTarget)} type="button">
          <Icon name="plus" /> Add term
        </button>
      </header>
      <div className="history-tools">
        <SearchField label="Search dictionary" onChange={setQuery} placeholder="Search words" value={query} />
        <span aria-live="polite" className="fine">
          {query ? `${words.length} of ${count(state.words.length)}` : count(state.words.length)}
        </span>
      </div>
      <div className="term-grid">
        {words.map((word) => (
          <div className="term-row" key={word} tabIndex={0}>
            <strong>{word}</strong>
            <div className="action-group term-row__actions">
              <IconButton icon="edit" label={`Edit ${word}`} onClick={(event) => edit(word, event.currentTarget)} />
              <IconButton icon="trash" label={`Delete ${word}`} onClick={() => dictionary.delete(word)} tone="danger" />
            </div>
          </div>
        ))}
        {!words.length && (
          <EmptyState icon="book" title={query ? 'No words found.' : 'No words yet'}>
            {query ? 'Try another search.' : 'Add names and terms you use often.'}
          </EmptyState>
        )}
      </div>
      {open && (
        <WordDialog
          editing={editing}
          onClose={() => setOpen(false)}
          onSave={(word, previous) => {
            dictionary.save(word, previous);
            setOpen(false);
          }}
          opener={opener.current}
          words={state.words}
        />
      )}
    </section>
  );
}
