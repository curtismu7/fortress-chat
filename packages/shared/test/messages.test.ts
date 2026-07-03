import { describe, it, expect } from 'vitest';
import { validateHistory, HistoryValidationError } from '../src/messages';

describe('validateHistory', () => {
  it('accepts well-formed history', () => {
    const h = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    expect(validateHistory(h)).toEqual(h);
  });

  it('REGRESSION llama-vscode poison bug: rejects role-less entry', () => {
    const h = [{ content: 'Request failed with status code 503' }];
    expect(() => validateHistory(h)).toThrow(HistoryValidationError);
  });

  it('rejects unknown role and non-string content', () => {
    expect(() => validateHistory([{ role: 'oops', content: 'x' }])).toThrow(HistoryValidationError);
    expect(() => validateHistory([{ role: 'user', content: 42 }])).toThrow(HistoryValidationError);
  });

  it('accepts assistant tool_calls and tool results', () => {
    const h = [
      { role: 'assistant', content: '', tool_calls: [{ id: '1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
      { role: 'tool', content: 'file body', tool_call_id: '1' },
    ];
    expect(validateHistory(h)).toEqual(h);
  });
});
