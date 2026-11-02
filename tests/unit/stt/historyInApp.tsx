/** BUS-91: put a record through the real app state and Copy it from History. */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { vi, type Mock } from 'vitest';
import { AppProvider, useApp } from '../../../src/app/AppContext';
import type { AppAction } from '../../../src/app/actions';
import type { DictationRecord } from '../../../src/domain/types';
import { History } from '../../../src/features/history/History';

/** Retention off, as App.tsx appends it; returns what History's Copy wrote. */
export async function copyFromHistoryWithRetentionOff(record: DictationRecord) {
  const writeText: Mock<(text: string) => Promise<void>> = vi.fn(async () => {});
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  let dispatch!: (action: AppAction) => void;
  function Probe() { dispatch = useApp().dispatch; return null; }
  const view = render(<AppProvider clock={() => 1_800_000_000_000}><Probe />
    <History onToast={vi.fn()} /></AppProvider>);
  act(() => {
    dispatch({ key: 'transcriptRetention', type: 'set-setting', value: 'off' });
    dispatch({ record, type: 'append-record' });
  });
  screen.getByText(/Transcript retention is off/);
  const row = screen.getAllByRole('article').find((item) => item.textContent?.includes(record.text));
  if (!row) throw new Error('record not in History');
  await act(async () => {
    fireEvent.click(within(row).getByRole('button', { name: 'Copy transcript' }));
  });
  view.unmount();
  vi.unstubAllGlobals();
  return writeText.mock.calls.map(([text]) => text);
}
