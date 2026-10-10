import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint();

async function lint(source: string) {
  const [result] = await eslint.lintText(source, { filePath: 'src/style-check.ts' });
  return result.messages.map(({ ruleId }) => ruleId);
}

describe('TypeScript style lint', () => {
  it('rejects double-quoted ordinary strings', async () => {
    expect(await lint('export const value = "hello";')).toContain('@stylistic/quotes');
  });

  it('accepts single-quoted strings with semicolons', async () => {
    expect(await lint('export const value = \'hello\';')).toEqual([]);
  });

  it('requires semicolons', async () => {
    expect(await lint('export const value = \'hello\'')).toContain('@stylistic/semi');
  });

  it('leaves JSX attribute quotes alone', async () => {
    const [result] = await eslint.lintText(
      'export const element = <div title="hello" />;',
      { filePath: 'src/style-check.tsx' },
    );
    expect(result.messages).toEqual([]);
  });
});
