import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { IconButton } from '../../../src/components/IconButton';
import { comboKeys, KeyCombo } from '../../../src/components/KeyCombo';
import { SearchField } from '../../../src/components/SearchField';
import { SegmentedControl } from '../../../src/components/SegmentedControl';
import { Switch } from '../../../src/components/Switch';

const options = [
  { value: 'all', label: 'All' },
  { value: 'inserted', label: 'Inserted' },
  { value: 'copied', label: 'Copied' },
] as const;
type V = (typeof options)[number]['value'];

function Seg({ onChange }: { onChange?: (v: V) => void }) {
  const [value, setValue] = useState<V>('all');
  return <SegmentedControl label="Status" onChange={(v) => { setValue(v); onChange?.(v); }} options={options} value={value} />;
}

describe('SegmentedControl', () => {
  it('is a radiogroup with one tab stop on the selected option', () => {
    render(<Seg />);
    expect(screen.getByRole('radiogroup', { name: 'Status' })).toBeTruthy();
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
  });

  it('moves and selects with arrows (wrapping), Home and End', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Seg onChange={onChange} />);
    await user.tab();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Inserted' }));
    await user.keyboard('{ArrowDown}{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'All' }).getAttribute('aria-checked')).toBe('true');
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Copied' }));
    await user.keyboard('{Home}');
    await user.keyboard('{End}');
    expect(onChange.mock.calls.map(([v]) => v)).toEqual(['inserted', 'copied', 'all', 'copied', 'all', 'copied']);
  });

  it('checks nothing for an unknown value but keeps the first option focusable', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SegmentedControl label="Status" onChange={onChange} options={options} value={'gone' as V} />);
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false', 'false']);
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    await user.tab();
    expect(document.activeElement).toBe(radios[0]);
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{ArrowLeft}');
    expect(onChange.mock.calls.map(([v]) => v)).toEqual(['all', 'copied']);
  });

  it('selects on click', async () => {
    render(<Seg />);
    await userEvent.click(screen.getByRole('radio', { name: 'Copied' }));
    expect(screen.getByRole('radio', { name: 'Copied' }).getAttribute('aria-checked')).toBe('true');
  });
});

describe('Switch', () => {
  it('toggles with click and keyboard, and respects disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<Switch checked={false} label="Clipboard fallback" onChange={onChange} />);
    const sw = screen.getByRole('switch', { name: 'Clipboard fallback' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    await user.click(sw);
    sw.focus();
    await user.keyboard(' ');
    expect(onChange.mock.calls).toEqual([[true], [true]]);
    rerender(<Switch checked disabled hideLabel label="Start at login" onChange={onChange} />);
    const off = screen.getByRole('switch', { name: 'Start at login' });
    expect(off.getAttribute('aria-checked')).toBe('true');
    await user.click(off);
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe('IconButton', () => {
  it('uses the label as accessible name and fires onClick', async () => {
    const onClick = vi.fn();
    render(<IconButton icon="trash" label="Delete" onClick={onClick} tone="danger" />);
    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button.className).toContain('ib--danger');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('KeyCombo', () => {
  it('maps modifier names to Mac symbols', () => {
    expect(comboKeys('Ctrl + Shift + Space')).toEqual(['⌃', '⇧', 'Space']);
    expect(comboKeys('CommandOrControl+Alt+k')).toEqual(['⌘', '⌥', 'K']);
    expect(comboKeys('Option + Cmd + 1')).toEqual(['⌥', '⌘', '1']);
  });

  it('renders key caps with the original text as its name', () => {
    render(<KeyCombo combo="Ctrl + Shift + Space" />);
    const combo = screen.getByRole('img', { name: 'Ctrl + Shift + Space' });
    expect([...combo.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['⌃', '⇧', 'Space']);
  });
});

describe('SearchField', () => {
  it('reports typing and clears on Escape', async () => {
    const user = userEvent.setup();
    function Host() {
      const [q, setQ] = useState('');
      return <SearchField label="Search history" onChange={setQ} value={q} />;
    }
    render(<Host />);
    const box = screen.getByRole('searchbox', { name: 'Search history' }) as HTMLInputElement;
    await user.type(box, 'notes');
    expect(box.value).toBe('notes');
    await user.keyboard('{Escape}');
    expect(box.value).toBe('');
  });
});
