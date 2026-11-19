// Fails when the committed bundle differs from a fresh `npm run build` (changed or untracked files in dist/).
// On failure it prints the diff stat and the start of the diff, so a CI failure shows what changed.
import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const out = git('status', '--porcelain', '--untracked-files=all', '--', 'dist/');
if (out.trim()) {
  const diff = git('diff', '--', 'dist/').split('\n').slice(0, 40).join('\n');
  console.error(`dist/ is out of date with the sources. Run \`npm run build\` and commit it:\n${out}`);
  console.error(`${git('diff', '--stat', '--', 'dist/')}\n${diff}`);
  process.exit(1);
}
console.log('dist/ matches the sources.');
