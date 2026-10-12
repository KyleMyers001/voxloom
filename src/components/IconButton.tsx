import type { ButtonHTMLAttributes } from 'react';
import { Icon, type IconName } from './Icon';

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> & {
  icon: IconName;
  label: string;
  tone?: 'default' | 'danger';
};

/** Icon-only button; `label` is its accessible name and tooltip. */
export function IconButton({ icon, label, tone = 'default', className, ...rest }: Props) {
  const classes = ['ib', tone === 'danger' ? 'ib--danger' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <button {...rest} aria-label={label} className={classes} title={label} type={rest.type ?? 'button'}>
      <Icon name={icon} />
    </button>
  );
}
