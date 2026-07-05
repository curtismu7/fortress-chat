import { describe, it, expect } from 'vitest';
import { exportMarkdown } from '../exportChat';

describe('exportMarkdown', () => {
  it('renders title, date, roles, and sources', () => {
    const md = exportMarkdown('My chat', [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello', sources: [{ file: 'a.ts', startLine: 1, endLine: 3 }] },
      { role: 'tool', content: 'ignored' },
    ] as any, new Date('2026-07-05T12:00:00Z'));
    expect(md).toContain('# My chat');
    expect(md).toContain('2026-07-05');
    expect(md).toContain('## User\n\nhi');
    expect(md).toContain('## Assistant\n\nhello');
    expect(md).toContain('- a.ts:L1-L3');
    expect(md).not.toContain('ignored');
  });
});
