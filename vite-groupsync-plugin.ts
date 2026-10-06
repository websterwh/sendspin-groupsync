/**
 * Vite plugin: runs the GroupSync server core inside the dev/preview server
 * (secure-websocket proxy to MA, click-track server, helper endpoints).
 * Settings (MA_TOKEN, MA_URL) are kept in .env.local.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import { createGroupSyncCore } from './server/core';

function envFiles(root: string): string[] {
  return [path.join(root, '.env.local'), path.join(root, '.env')];
}

/** A key from the process env or .env.local / .env (re-read each time so saving takes effect without a restart) */
function readEnvValue(root: string, key: string): string | null {
  if (process.env[key]) return process.env[key]!;
  for (const file of envFiles(root)) {
    try {
      const m = new RegExp(`^${key}=(.*)$`, 'm').exec(fs.readFileSync(file, 'utf8'));
      if (m && m[1].trim()) return m[1].trim().replace(/^['"]|['"]$/g, '');
    } catch {
      // file missing
    }
  }
  return null;
}


/** Write (or with null, remove) a key in .env.local */
function writeEnvValue(root: string, key: string, value: string | null): void {
  const file = envFiles(root)[0];
  let content = '';
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    // new file
  }
  const lines = content.split('\n').filter((l) => l && !l.startsWith(`${key}=`));
  if (value) lines.push(`${key}=${value}`);
  const next = lines.join('\n') + (lines.length ? '\n' : '');
  if (next !== content) fs.writeFileSync(file, next, { mode: 0o600 });
}



export function groupSyncPlugin(): Plugin {
  let rootDir = process.cwd();
  const core = createGroupSyncCore({
    mediaPort: Number(process.env.GROUPSYNC_MEDIA_PORT ?? 5174),
    getSetting: (key) => readEnvValue(rootDir, key),
    setSetting: (key, value) => writeEnvValue(rootDir, key, value),
    // Dev-only song test: drop audio files in ./groupsync-music (not used by the add-on build)
    musicDir: process.env.NODE_ENV === 'production' ? undefined : path.join(process.cwd(), 'groupsync-music'),
  });

  const attach = (server: { config: { root: string }; middlewares: { use: (fn: never) => void }; httpServer: import('node:http').Server | null }) => {
    rootDir = server.config.root;
    core.startMediaServer();
    server.middlewares.use(core.handleRequest as never);
    server.httpServer?.on('upgrade', (req, socket, head) => {
      core.handleUpgrade(req, socket, head);
    });
    server.httpServer?.on('close', () => core.stopMediaServer());
  };

  return {
    name: 'groupsync',
    configureServer: attach as never,
    configurePreviewServer: attach as never,
  };
}
