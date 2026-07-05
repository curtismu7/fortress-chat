import { describe, it, expect } from 'vitest';
import { EmbedSupervisor } from '../src/embedSupervisor';

describe('EmbedSupervisor.buildArgs', () => {
  it('runs llama-server in embedding mode with mean pooling, no --jinja', () => {
    const s = new EmbedSupervisor();
    (s as any).port = 9999;
    const args = s.buildArgs('/models/nomic.gguf');
    expect(args).toContain('--embedding');
    expect(args).toEqual(expect.arrayContaining(['--pooling', 'mean']));
    expect(args).toEqual(expect.arrayContaining(['-m', '/models/nomic.gguf']));
    expect(args).toEqual(expect.arrayContaining(['--port', '9999']));
    expect(args).not.toContain('--jinja');
  });
});
