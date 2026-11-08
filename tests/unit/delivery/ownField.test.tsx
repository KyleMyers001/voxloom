import { act, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { insertIntoOwnField } from '../../../src/services/delivery/ownField';

function Search({ onChange }: { onChange?: (v: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <input
      aria-label="Search words"
      onChange={(e) => {
        setValue(e.target.value);
        onChange?.(e.target.value);
      }}
      value={value}
    />
  );
}

describe('insertIntoOwnField (BUS-201)', () => {
  it('inserts at the caret of a focused React-controlled field', () => {
    const onChange = vi.fn();
    render(<Search onChange={onChange} />);
    const input = screen.getByLabelText<HTMLInputElement>('Search words');
    act(() => input.focus());
    let inserted = false;
    act(() => { inserted = insertIntoOwnField('voxloom'); });
    expect(inserted).toBe(true);
    expect(input.value).toBe('voxloom');
    expect(onChange).toHaveBeenLastCalledWith('voxloom');
    expect(input.selectionStart).toBe(7);
  });

  it('replaces the selection and keeps surrounding text', () => {
    render(<textarea aria-label="notes" defaultValue="one two three" />);
    const area = screen.getByLabelText<HTMLTextAreaElement>('notes');
    area.focus();
    area.setSelectionRange(4, 7);
    expect(insertIntoOwnField('2')).toBe(true);
    expect(area.value).toBe('one 2 three');
    expect(area.selectionStart).toBe(5);
  });

  it('declines when no text field is focused', () => {
    render(<button type="button">Add</button>);
    screen.getByRole('button').focus();
    expect(insertIntoOwnField('x')).toBe(false);
  });

  it('declines password, read-only and disabled fields', () => {
    render(
      <>
        <input aria-label="pw" type="password" />
        <input aria-label="ro" readOnly />
        <input aria-label="off" disabled />
      </>,
    );
    for (const label of ['pw', 'ro', 'off']) {
      const field = screen.getByLabelText<HTMLInputElement>(label);
      field.focus();
      expect(insertIntoOwnField('x')).toBe(false);
      expect(field.value).toBe('');
    }
  });

  it('declines when the window does not have focus', () => {
    render(<Search />);
    const input = screen.getByLabelText<HTMLInputElement>('Search words');
    input.focus();
    const spy = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    expect(insertIntoOwnField('x')).toBe(false);
    expect(input.value).toBe('');
    spy.mockRestore();
  });
});
