export interface Parsed {
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** Minimal parser: `--flag`, `--key value`, `--key=value`; everything after `--` is positional. */
export function parseArgs(argv: string[], valued: string[]): Parsed {
  const out: Parsed = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      out.positional.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith('--')) {
      out.positional.push(a);
      continue;
    }
    const [key, inline] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (inline !== undefined) out.flags[key] = inline;
    else if (valued.includes(key) && i + 1 < argv.length) out.flags[key] = argv[++i]!;
    else out.flags[key] = true;
  }
  return out;
}

export function str(p: Parsed, key: string): string | undefined {
  const v = p.flags[key];
  return typeof v === 'string' ? v : undefined;
}

/** A positive integer, or `def` when the flag is absent; anything else is an error. */
export function int(p: Parsed, key: string, def: number): number {
  const v = p.flags[key];
  if (v === undefined) return def;
  const n = Number(v);
  if (typeof v !== 'string' || v.trim() === '' || !Number.isInteger(n) || n <= 0) {
    throw new Error(`--${key} must be a positive whole number (got ${JSON.stringify(v)})`);
  }
  return n;
}

/** A positive number, or undefined when the flag is absent; anything else is an error. */
export function positive(p: Parsed, key: string): number | undefined {
  const v = p.flags[key];
  if (v === undefined) return undefined;
  const n = Number(v);
  if (typeof v !== 'string' || !Number.isFinite(n) || n <= 0) throw new Error(`--${key} must be a positive number (got ${JSON.stringify(v)})`);
  return n;
}

/** A warning threshold: tokens ("160000") or a share of the budget ("80%"). */
export function warnArg(p: Parsed): number | string | undefined {
  const v = p.flags.warn;
  if (v === undefined) return undefined;
  if (typeof v === 'string' && /^\d+(\.\d+)?%$/.test(v.trim()) && parseFloat(v) > 0 && parseFloat(v) <= 100) return v.trim();
  return positive(p, 'warn');
}

/** A date or month prefix (YYYY-MM or YYYY-MM-DD) that exists, or undefined when absent. */
export function dateArg(p: Parsed, key: string): string | undefined {
  const v = p.flags[key];
  if (v === undefined) return undefined;
  const m = typeof v === 'string' ? /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(v) : null;
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3] ?? 1))) : null;
  if (!m || !d || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3] ?? 1)) {
    throw new Error(`--${key} must be a date like 2026-01-31 or 2026-01 (got ${JSON.stringify(v)})`);
  }
  return v as string;
}
