import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

type Props = { title: string; children?: ReactNode; icon?: IconName; compact?: boolean; action?: ReactNode };

export function EmptyState({ title, children, icon, compact = false, action }: Props) {
  return (
    <div className={compact ? 'empty empty--sm' : 'empty'}>
      {icon ? <Icon name={icon} size={compact ? 14 : 22} /> : null}
      <b>{title}</b>
      {children ? <span>{children}</span> : null}
      {action}
    </div>
  );
}
