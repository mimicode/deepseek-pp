import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('content tool block styles', () => {
  it('keeps restored tool detail content scrollable for long source output', () => {
    const path = join(process.cwd(), 'entrypoints/content.ts');
    const source = readFileSync(path, 'utf8');
    const rule = source.match(/\.dpp-tool-block-item-detail \{([\s\S]*?)\n    \}/)?.[1] ?? '';

    expect(rule).toContain('max-height:');
    expect(rule).toContain('overflow: auto;');
    expect(rule).toContain('overscroll-behavior: contain;');
  });
});
