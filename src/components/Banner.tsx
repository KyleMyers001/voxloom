import type { ReactNode } from 'react';
import { Icon } from './Icon';

export type BannerTone = 'info' | 'warn' | 'error' | 'ok';

type Props = { tone?: BannerTone; children: ReactNode; action?: ReactNode };

/** Inline notice. Errors are announced (role="alert"); others are status. */
export function Banner({ tone = 'info', children, action }: Props) {
  return (
    <div className={`banner banner--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon name={tone === 'ok' ? 'check' : 'warn'} size={14} />
      <span className="banner__text">{children}</span>
      {action}
    </div>
  );
}
