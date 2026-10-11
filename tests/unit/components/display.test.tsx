import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Badge, type BadgeStatus } from '../../../src/components/Badge';
import { Banner } from '../../../src/components/Banner';
import { EmptyState } from '../../../src/components/EmptyState';
import { FormRow } from '../../../src/components/FormRow';
import { Icon, iconNames } from '../../../src/components/Icon';
import { ProgressBar } from '../../../src/components/ProgressBar';

describe('Icon', () => {
  it('ships the full spec set and is decorative unless labelled', () => {
    expect(iconNames).toEqual(['house', 'clock', 'book', 'gear', 'copy', 'trash', 'retry', 'edit',
      'search', 'mic', 'plus', 'x', 'down', 'check', 'warn', 'keyboard']);
    const { container } = render(<><Icon name="mic" /><Icon label="Warning" name="warn" /></>);
    expect(container.querySelector('[data-icon="mic"]')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('img', { name: 'Warning' })).toBeTruthy();
  });
});

describe('Badge', () => {
  it('states every status in text', () => {
    const statuses: BadgeStatus[] = ['inserted', 'copied', 'failed', 'unverified', 'missing', 'downloading', 'available'];
    render(<>{statuses.map((s) => <Badge key={s} status={s} />)}</>);
    for (const text of ['Inserted', 'Copied', 'Failed', 'Unverified', 'Not downloaded', 'Downloading', 'On disk']) {
      expect(screen.getByText(text)).toBeTruthy();
    }
    expect(screen.getByText('Failed').className).toBe('badge badge--failed');
  });

  it('accepts a custom label', () => {
    render(<Badge status="downloading">42%</Badge>);
    expect(screen.getByText('42%').dataset.status).toBe('downloading');
  });
});

describe('Banner', () => {
  it('announces errors as alerts and other tones as status', () => {
    render(<>
      <Banner action={<button type="button">Try again</button>} tone="error">Couldn't load the model list</Banner>
      <Banner tone="warn">Heads up</Banner>
    </>);
    expect(screen.getByRole('alert').textContent).toContain('Couldn\'t load the model list');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.getByRole('status').className).toBe('banner banner--warn');
  });
});

describe('EmptyState', () => {
  it('renders title, body and optional action', () => {
    render(<EmptyState action={<button type="button">Add term</button>} icon="book" title="No terms yet">Add words Voxloom should spell your way.</EmptyState>);
    expect(screen.getByText('No terms yet')).toBeTruthy();
    expect(screen.getByText(/spell your way/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add term' })).toBeTruthy();
  });
});

describe('ProgressBar', () => {
  it('exposes a clamped, rounded value', () => {
    render(<><ProgressBar caption="42%" label="Downloading tiny" value={41.6} /><ProgressBar label="Over" value={140} /><ProgressBar label="NaN" value={Number.NaN} /></>);
    expect(screen.getByRole('progressbar', { name: 'Downloading tiny' }).getAttribute('aria-valuenow')).toBe('42');
    expect(screen.getByRole('progressbar', { name: 'Over' }).getAttribute('aria-valuenow')).toBe('100');
    expect(screen.getByRole('progressbar', { name: 'NaN' }).getAttribute('aria-valuenow')).toBe('0');
  });
});

describe('FormRow', () => {
  it('associates the label with its control and shows tag and help', () => {
    render(<FormRow help="Used when insertion isn't safe." htmlFor="mic" label="Microphone" tag="English-first"><select id="mic" /></FormRow>);
    expect(screen.getByLabelText('Microphone').tagName).toBe('SELECT');
    expect(screen.getByText('English-first')).toBeTruthy();
    expect(screen.getByText(/insertion isn't safe/)).toBeTruthy();
  });
});
