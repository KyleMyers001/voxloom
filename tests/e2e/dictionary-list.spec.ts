import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

async function openDictionary(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await page.getByRole('button', { name: 'Dictionary', exact: true }).click();
}

// Public synthetic vocabulary only; browser state stays memory-only.
const previewWords = [
  'API', 'async', 'AST', 'backoff', 'bytecode', 'cache', 'CLI', 'codec',
  'daemon', 'debounce', 'endpoint', 'event loop', 'fallback', 'Git', 'gRPC',
  'hash', 'HTTP', 'idempotent', 'JSON', 'kernel', 'latency', 'Markdown',
  'mutex', 'Node.js', 'OAuth', 'pipeline', 'query', 'Rust', 'SDK',
  'TypeScript', 'Unicode', 'WebSocket', 'YAML', 'zero-copy',
];

async function addWord(page: Page, word: string) {
  await page.getByRole('button', { name: 'Add term', exact: true }).click();
  await page.getByRole('textbox', { name: 'Word', exact: true }).fill(word);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
}

async function usePreviewWords(page: Page) {
  for (const word of ['JSON', 'Postgres', 'TanStack Query', 'TypeScript']) {
    await page.getByRole('button', { name: `Delete ${word}`, exact: true }).click();
  }
  await expect(page.getByText('No words yet', { exact: true })).toBeVisible();
  await expect(page.getByText('0 words', { exact: true })).toBeVisible();
  for (const word of previewWords) await addWord(page, word);
}

for (const width of [640, 1120, 1600]) {
  test(`dense list keeps its range and border on screen at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ height: 760, width });
    await page.emulateMedia({ colorScheme: width === 1600 ? 'dark' : 'light', reducedMotion: 'reduce' });
    await openDictionary(page);
    await usePreviewWords(page);
    const list = page.getByRole('list', { name: 'Dictionary words, alphabetical' });
    await expect(list.getByRole('listitem')).toHaveCount(34);
    await page.mouse.move(1, 1);
    const geometry = await list.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        bottom: rect.bottom, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
        rows: [...element.children].map((child) => {
          const { height, x, y } = child.getBoundingClientRect();
          return { height, word: child.querySelector('strong')?.textContent, x, y };
        }),
      };
    });
    await testInfo.attach('dense-geometry', { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' });
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
    expect(geometry.bottom).toBeLessThan(730);
    const expected = [...previewWords].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    expect(geometry.rows.map(({ word }) => word)).toEqual(expected);
    for (const [index, row] of geometry.rows.entries()) {
      expect(row.x).toBeCloseTo(geometry.rows[0].x, 1);
      expect(row.height).toBe(44);
      if (index) expect(row.y - geometry.rows[index - 1].y).toBe(44);
    }
    await expect(list).toHaveCSS('border-top-width', '1px');
    await expect(list.getByRole('listitem').first()).toHaveCSS('border-top-width', '0px');
    await expect(list.getByRole('listitem').first()).toHaveCSS('border-bottom-width', '1px');
    const footer = page.locator('.dictionary-list-foot');
    expect((await footer.boundingBox())!.y + (await footer.boundingBox())!.height).toBeLessThan(760);
    await expect(page.locator('.dictionary .search')).toHaveCSS('height', '34px');
    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(accessibility.violations.filter(({ impact }) => impact === 'critical' || impact === 'serious')).toEqual([]);
    await expect(list.getByRole('listitem').first()).toHaveCSS('transition-duration', '0s');
    await page.screenshot({ path: testInfo.outputPath(`production-dictionary-a-${width}.png`) });
    await list.getByRole('listitem').last().getByRole('button', { name: 'Edit zero-copy' }).focus();
    await expect(list.getByRole('listitem').last().getByRole('button', { name: 'Edit zero-copy' })).toBeInViewport();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('textbox', { name: 'Word', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await page.getByRole('searchbox').fill('no-match');
    await expect(page.getByText('0 of 34 words', { exact: true })).toBeVisible();
    await expect(page.getByText('No words found.', { exact: true })).toBeVisible();
  });
}

for (const width of [640, 1120, 1600]) {
  test(`long spellings wrap clear of aligned actions at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ height: 760, width });
    await openDictionary(page);
    await addWord(page, 'LongCanonicalSpelling'.repeat(12));
    const rows = await page.locator('.term-row').evaluateAll((elements) => elements.map((element) => {
      const row = element.getBoundingClientRect();
      const name = element.querySelector('strong')!.getBoundingClientRect();
      const actions = element.querySelector('.term-row__actions')!.getBoundingClientRect();
      return { actionRight: actions.right, actionX: actions.x, height: row.height, nameHeight: name.height, nameRight: name.right, right: row.right };
    }));
    expect(rows[1].height).toBeGreaterThan(44);
    expect(rows[1].nameHeight).toBeGreaterThan(30);
    for (const row of rows) {
      expect(row.nameRight).toBeLessThan(row.actionX);
      expect(row.actionRight).toBeLessThan(row.right);
      expect(row.actionX).toBeCloseTo(rows[0].actionX, 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  });
}

test.describe('coarse pointer', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { height: 760, width: 640 } });

  test('keeps both persistent actions at least 44px', async ({ page }) => {
    await openDictionary(page);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    const buttons = page.getByRole('listitem').first().getByRole('button');
    for (const button of await buttons.all()) {
      await expect(button).toBeVisible();
      const box = (await button.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await buttons.first().tap();
    await expect(page.getByRole('textbox', { name: 'Word', exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Cancel', exact: true }).tap();
    await expect(buttons.first()).toBeFocused();
  });
});

test('row actions are persistent pointer targets and direct keyboard stops', async ({ page }) => {
  await page.setViewportSize({ height: 760, width: 1120 });
  await openDictionary(page);
  await page.mouse.move(1, 1);
  const edit = page.getByRole('button', { name: 'Edit JSON', exact: true });
  const remove = page.getByRole('button', { name: 'Delete JSON', exact: true });
  await expect(edit).toBeVisible();
  await expect(edit.locator('..')).toHaveCSS('opacity', '1');
  await expect(remove).toBeVisible();
  await page.getByRole('searchbox').focus();
  await page.keyboard.press('Tab');
  await expect(edit).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Word', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(edit).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(remove).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText('3 words', { exact: true })).toBeVisible();
  const add = page.getByRole('button', { name: 'Add term', exact: true });
  await add.click();
  const field = page.getByRole('textbox', { name: 'Word', exact: true });
  await expect(field).toBeFocused();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(field).toHaveAccessibleDescription('Enter a word.');
  await field.fill(' TypeScript ');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('already');
  await field.fill('Zebra');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(add).toBeFocused();
  await expect(page.getByText('4 words', { exact: true })).toBeVisible();
  await page.getByRole('searchbox').fill('zeb');
  await expect(page.getByText('1 of 4 words', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit Zebra', exact: true }).click();
  await expect(field).toBeFocused();
  await field.fill('Zebrafish');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit Zebrafish', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delete Zebrafish', exact: true }).click();
  await expect(page.getByText('0 of 3 words', { exact: true })).toBeVisible();
  await expect(page.getByText('No words found.', { exact: true })).toBeVisible();
  await page.getByRole('searchbox').fill('');
  await expect(page.getByText('3 words', { exact: true })).toBeVisible();
});

for (const width of [640, 1120, 1600]) {
  test(`single alphabetical column at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ height: 760, width });
    await openDictionary(page);
    const rows = page.locator('.dictionary .term-row');
    await expect(rows).toHaveCount(4);
    const geometry = await rows.evaluateAll((elements) => elements.map((element) => {
      const { height, width, x, y } = element.getBoundingClientRect();
      return { height, width, word: element.querySelector('strong')?.textContent, x, y };
    }));
    console.log(JSON.stringify({ geometry, viewport: width }));
    await testInfo.attach('row-geometry', {
      body: JSON.stringify(geometry, null, 2), contentType: 'application/json',
    });
    await page.screenshot({ path: testInfo.outputPath(`dictionary-${width}.png`) });
    expect(geometry.map(({ word }) => word)).toEqual(['JSON', 'Postgres', 'TanStack Query', 'TypeScript']);
    for (const [index, row] of geometry.entries()) {
      expect(row.x, 'one shared left edge, never side-by-side tiles').toBeCloseTo(geometry[0].x, 1);
      expect(row.width).toBeCloseTo(geometry[0].width, 1);
      expect(row.height).toBeGreaterThanOrEqual(44);
      if (index) expect(row.y).toBeGreaterThanOrEqual(geometry[index - 1].y + geometry[index - 1].height);
    }
  });
}
