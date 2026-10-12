import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';

type ControlProps = { id?: string; 'aria-describedby'?: string };

type Props = {
  label: string;
  /**
   * Id for the control when the child has none. A child's own id always wins
   * (it is never overwritten); without either, FormRow generates one.
   */
  htmlFor?: string;
  help?: ReactNode;
  tag?: string;
  /** A single control element; FormRow wires its id and aria-describedby. */
  children: ReactElement<ControlProps>;
};

/** Settings-style row: label (+ optional tag and help) left, control right. */
export function FormRow({ label, htmlFor, help, tag, children }: Props) {
  const autoId = useId();
  const controlId = children.props.id ?? htmlFor ?? `frow-${autoId}`;
  const helpId = help ? `${controlId}-help` : undefined;
  const describedBy = [children.props['aria-describedby'], helpId].filter(Boolean).join(' ') || undefined;
  const control = isValidElement(children)
    ? cloneElement(children, { id: controlId, 'aria-describedby': describedBy })
    : (children as ReactNode);
  return (
    <div className="frow">
      <span className="frow__label">
        <label htmlFor={controlId}>{label}</label>
        {tag ? <span className="tag">{tag}</span> : null}
        {help ? <small className="frow__help" id={helpId}>{help}</small> : null}
      </span>
      <span className="frow__control">{control}</span>
    </div>
  );
}
