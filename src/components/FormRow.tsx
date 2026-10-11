import type { ReactNode } from 'react';

type Props = { label: string; htmlFor?: string; help?: ReactNode; tag?: string; children: ReactNode };

/** Settings-style row: label (+ optional tag and help) left, control right. */
export function FormRow({ label, htmlFor, help, tag, children }: Props) {
  return (
    <div className="frow">
      <span className="frow__label">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
        {tag ? <span className="tag">{tag}</span> : null}
        {help ? <small className="frow__help">{help}</small> : null}
      </span>
      <span className="frow__control">{children}</span>
    </div>
  );
}
