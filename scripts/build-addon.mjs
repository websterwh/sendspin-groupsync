/**
 * Builds the self-contained Home Assistant add-on folder (groupsync/app): the production web app plus
 * the bundled server. Run with `npm run build:addon`, then commit groupsync/.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'groupsync', 'app');

execSync('npx vite build', { cwd: root, stdio: 'inherit' });

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.join(root, 'dist'), path.join(out, 'dist'), { recursive: true });

await build({
  entryPoints: [path.join(root, 'server', 'index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: path.join(out, 'server.mjs'),
  external: ['bufferutil', 'utf-8-validate'],
  // ws is CommonJS; give the bundled code a require()
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
});
console.log('Add-on built in', out);
