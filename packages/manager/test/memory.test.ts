import { describe, it, expect } from 'vitest';
import { parseVmStat, checkFit, OVERHEAD_BYTES } from '../src/memory';

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                              100000.
Pages active:                           1000000.
Pages inactive:                          200000.
Pages speculative:                        50000.
Pages throttled:                              0.
Pages wired down:                        300000.
`;

describe('parseVmStat', () => {
  it('sums free+inactive+speculative times pagesize', () => {
    expect(parseVmStat(VM_STAT).availableBytes).toBe((100000 + 200000 + 50000) * 16384);
  });
});

describe('checkFit (64 GB machine)', () => {
  const total = 64 * 1024 ** 3;
  it('accepts gpt-oss-20b with plenty free', () => {
    expect(checkFit(14 * 1024 ** 3, 40 * 1024 ** 3, total)).toEqual({ fits: true });
  });
  it("REGRESSION 77GB-on-64GB pileup: rejects when it can't keep 15% headroom", () => {
    const r = checkFit(40 * 1024 ** 3, 20 * 1024 ** 3, total);
    expect(r.fits).toBe(false);
    if (!r.fits) expect(r.requiredBytes).toBe(40 * 1024 ** 3 + OVERHEAD_BYTES);
  });
});
