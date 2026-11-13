/// BUS-220 · Option A: the welcome step previews the three setup steps as numbered rows.
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { useApp } from '../../src/app/AppContext';
import { Onboarding } from '../../src/features/onboarding/Onboarding';
import type { SetupBoundary } from '../../src/features/onboarding/guidedSetup';
import { renderWithApp } from './testUtils';

const storage = () => ({ read: () => null, write: vi.fn() });
const setupBoundary = (): SetupBoundary => ({
  native: true, query: vi.fn().mockResolvedValue({ microphone: 'authorized', accessibility: 'authorized' }),
  readiness: vi.fn(async (modelId) => ({ modelId, ready: true, reason: null })),
  request: vi.fn(), openSettings: vi.fn(), download: vi.fn(), cancelDownload: vi.fn(), activeShortcut: () => 'Ctrl + Shift + Space',
});

function SetShortcut({ value }: { value: string }) {
  const { settings } = useApp();
  return <button onClick={() => settings.update({ key: 'shortcut', value })} type="button">Set test shortcut</button>;
}

describe('guided setup welcome (step 0)', () => {
  it('lists the three steps under the heading, titled like the spine, without the preview card', () => {
    renderWithApp(<Onboarding boundary={setupBoundary()} onClose={vi.fn()} progressStorage={storage()} />);
    const list = screen.getByRole('list', { name: 'Setup steps' });
    expect(list.tagName).toBe('OL');
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    const titles = within(list).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
    const spine = within(screen.getByRole('complementary', { name: 'Setup progress' })).getAllByRole('listitem').map((item) => item.querySelector('span')?.textContent);
    expect(titles).toEqual(['Get connected', 'Your shortcut', 'First words']);
    expect(titles).toEqual(spine);
    expect(rows[0]).toHaveTextContent('Allow Microphone and Accessibility so Voxloom can hear you and type for you.');
    expect(rows[2]).toHaveTextContent('Hold your shortcut and say a short sentence, then try it hands-free.');
    for (const [index, row] of rows.entries()) {
      const badge = row.querySelector('.guided-steps-badge');
      expect(badge).toHaveTextContent(String(index + 1));
      expect(badge).toHaveAttribute('aria-hidden', 'true');
    }
    expect(screen.queryByText('A LITTLE PREVIEW')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Illustrative preview/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Connect your microphone, typing and keyboard access/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Input Monitoring/)).not.toBeInTheDocument();
    expect(screen.getByText(/Starting setup downloads Whisper Base/)).toHaveTextContent('148 MB');
  });

  it('shows the live shortcut as key caps in the shortcut row', async () => {
    const user = userEvent.setup();
    renderWithApp(<><Onboarding boundary={setupBoundary()} onClose={vi.fn()} progressStorage={storage()} /><SetShortcut value="Alt + D" /></>);
    const row = within(screen.getByRole('list', { name: 'Setup steps' })).getAllByRole('listitem')[1];
    expect(row).toHaveTextContent(/^2Your shortcutKeep .*Control Shift Space, or pick your own keys\.$/);
    expect(row.querySelectorAll('.kbd')).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: 'Set test shortcut' }));
    expect(row).not.toHaveTextContent('Control Shift Space');
    expect(row.querySelector('.key-combo .sr-only')).toHaveTextContent(/^(Option|Alt) D$/);
    expect(row.querySelectorAll('.kbd')).toHaveLength(2);
  });
});
