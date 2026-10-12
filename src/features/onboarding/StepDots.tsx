/** Numbered step dots (mock: onboarding-*). Decorative; the text "Step n of 3" is read. */
export function StepDots({ step, total = 3 }: { step: number; total?: number }) {
  return (
    <div className="steps">
      {Array.from({ length: total }, (_, index) => (
        <span aria-hidden="true" className={index < step ? 'on' : undefined} key={index}>{index + 1}</span>
      ))}
      <em>Step {step} of {total}</em>
    </div>
  );
}
