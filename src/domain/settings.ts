export function parseChoice<const Choices extends readonly string[]>(
  value: string,
  choices: Choices,
): Choices[number] {
  const selected = choices.find((choice) => choice === value);
  if (selected === undefined) throw new Error(`Invalid setting: ${value}`);
  return selected;
}

export const audioRetentions = ['off', '24-hours', '7-days'] as const;
export const transcriptRetentions = ['30-days', 'forever', 'off'] as const;
export const writingStyles = ['formal', 'casual', 'very-casual'] as const;

export const textSizes = ['small', 'default', 'large'] as const;
