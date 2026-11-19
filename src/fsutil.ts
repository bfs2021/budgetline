import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';

/** Write through a temporary file and rename it over the target: a crash never leaves it half-written. */
export function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** A folder only the user can read (0700 on macOS and Linux; Windows keeps its own ACLs). */
export function privateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** A JSON settings file, null when missing; invalid JSON is an error that names the file and says nothing changed. */
export function readJsonFile(file: string): any { // eslint-disable-line @typescript-eslint/no-explicit-any -- untyped settings JSON
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  try {
    return text.trim() ? JSON.parse(text) : {};
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${(err as Error).message}). Nothing was changed: fix the file and run the command again.`);
  }
}

/** A complete JSON value: a last line without its newline that is already whole. */
function isJson(b: Buffer): boolean {
  if (!b.toString('utf8').trim()) return false;
  try {
    JSON.parse(b.toString('utf8'));
    return true;
  } catch {
    return false;
  }
}

/** The complete lines appended to `path` since byte `offset`; `shrunk` when the file is now shorter (start over). */
export function readNew(path: string, offset: number): { text: string; end: number; shrunk: boolean } {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size < offset) return { text: '', end: offset, shrunk: true };
    if (size === offset) return { text: '', end: offset, shrunk: false };
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    if (isJson(buf.subarray(buf.lastIndexOf(0x0a) + 1))) return { text: buf.toString('utf8'), end: size, shrunk: false };
    const end = buf.lastIndexOf(0x0a) + 1; // a last line without newline is still being written
    return { text: buf.subarray(0, end).toString('utf8'), end: offset + end, shrunk: false };
  } finally {
    closeSync(fd);
  }
}
