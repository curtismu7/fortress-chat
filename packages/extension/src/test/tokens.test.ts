import { describe, it, expect } from 'vitest';
import { estimateTokens, estimateMessagesTokens } from '../tokens';

describe('tokens', () => {
  it('estimates ~len/4', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(10))).toBe(3);
  });
  it('sums messages with overhead', () => {
    expect(estimateMessagesTokens([{ content: 'abcd' }, { content: 'abcd' }])).toBeGreaterThanOrEqual(2);
  });
});
