import { describe, it, expect } from 'vitest';
import { parsePs } from '../src/processes';

const PS = `  123  4096 /usr/bin/some-daemon
  456 9437184 llama-server -m /Users/x/models/gemma.gguf --port 8094
  789 1048576 llama serve -m /Users/x/models/star.gguf --port 8012
  790  512000 /opt/homebrew/bin/ollama runner --model foo
  801  2048 grep llama-server
`;

describe('parsePs', () => {
  it('finds llama-server, llama serve, and ollama runner with rss in bytes', () => {
    const found = parsePs(PS, []);
    expect(found.map((p) => p.pid)).toEqual([456, 789, 790]);
    expect(found[0].rssBytes).toBe(9437184 * 1024); // ps rss is KiB
  });

  it('excludes our managed pid', () => {
    expect(parsePs(PS, [456]).map((p) => p.pid)).toEqual([789, 790]);
  });

  it('ignores grep-like matches without model flags', () => {
    expect(parsePs(PS, []).map((p) => p.pid)).not.toContain(801);
  });
});
