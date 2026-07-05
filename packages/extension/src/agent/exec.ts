export function truncate(text: string, max = 10_000): string {
  const t = String(text);
  return t.length > max ? t.slice(0, max) + `\n…(${t.length - max} more chars truncated)` : t;
}

export function parseRgHits(stdout: string, cap = 100): string {
  const hits = String(stdout).split('\n').filter((l) => /^.+:\d+:/.test(l));
  const capped = hits.slice(0, cap);
  return capped.join('\n') + (hits.length > cap ? `\n…(${hits.length - cap} more matches)` : '');
}
