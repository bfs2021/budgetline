/** Round to 2 significant figures: estimates must not look more precise than they are. */
export function round2(n: number): number {
  if (n === 0 || !Number.isFinite(n)) return 0;
  const p = Math.pow(10, Math.floor(Math.log10(Math.abs(n))) - 1);
  return Math.round(n / p) * p;
}

/** Compact token count: 950, 24k, 1.2M (2 significant figures). */
export function tokens(n: number): string {
  const r = round2(n);
  if (r >= 1e6) return `${trim(r / 1e6)}M`;
  if (r >= 1e3) return `${trim(r / 1e3)}k`;
  return String(Math.round(r));
}

/** Exact-ish token count for history tables (no estimate involved). */
export function tokensExact(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

export function usd(n: number | null, approx = false): string {
  if (n === null) return 'n/a';
  const v = approx ? round2(n) : n;
  if (v < 0.01) return '<$0.01';
  return `$${v >= 100 ? Math.round(v) : approx ? trim(v) : String(Number(v.toFixed(2)))}`;
}

function trim(n: number): string {
  return String(Number(n.toFixed(1)));
}

export function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

export function truncate(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** Plain-text table with left-aligned first columns and right-aligned numbers. */
export function table(head: string[], rows: string[][], rightFrom = 1): string {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (r: string[]) =>
    r.map((c, i) => (i >= rightFrom ? c.padStart(widths[i]!) : c.padEnd(widths[i]!))).join('  ').trimEnd();
  return [line(head), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

/** Last folder of a project path, for display. */
export function projectName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}
