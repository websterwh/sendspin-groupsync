/**
 * Production server for the Home Assistant add-on (also usable as a plain container).
 *
 * - Serves the built web app (dist/) and the GroupSync endpoints on PORT (default 8099).
 * - Serves the click track over plain HTTP on MEDIA_PORT (default 5174) for Music Assistant.
 * - Settings come from the add-on options (/data/options.json) or environment variables:
 *     ma_url / MA_URL        Music Assistant address, e.g. 192.168.1.9:8095
 *     ma_token / MA_TOKEN    Music Assistant long-lived access token (never sent to the browser)
 *     media_host / MEDIA_HOST  address Music Assistant should use to reach the click track (optional)
 * - With INGRESS_ONLY=1 only Home Assistant's ingress gateway (172.30.32.2) may connect to PORT,
 *   since this port can use the saved token on the user's behalf.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createGroupSyncCore } from './core';

function loadOptions(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(process.env.OPTIONS_FILE ?? '/data/options.json', 'utf8'));
  } catch {
    return {};
  }
}

const options = loadOptions();
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const settings: Record<string, string | null> = {
  MA_URL: str(options.ma_url) ?? str(process.env.MA_URL),
  MA_TOKEN: str(options.ma_token) ?? str(process.env.MA_TOKEN),
  MEDIA_HOST: str(options.media_host) ?? str(process.env.MEDIA_HOST),
};

const PORT = Number(process.env.PORT ?? 8099);
const MEDIA_PORT = Number(process.env.MEDIA_PORT ?? 5174);
const DIST_DIR = path.resolve(process.env.DIST_DIR ?? 'dist');
const INGRESS_ONLY = process.env.INGRESS_ONLY === '1';
const INGRESS_ADDRESSES = new Set(['172.30.32.2', '::ffff:172.30.32.2']);

const core = createGroupSyncCore({ mediaPort: MEDIA_PORT, getSetting: (key) => settings[key] ?? null });

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  let file = path.join(DIST_DIR, urlPath === '/' ? 'index.html' : urlPath);
  // Stay inside DIST_DIR
  if (!file.startsWith(DIST_DIR)) {
    res.statusCode = 403;
    return res.end();
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST_DIR, 'index.html');
  const ext = path.extname(file);
  res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
  res.setHeader(
    'Cache-Control',
    file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache'
  );
  fs.createReadStream(file).pipe(res);
}

const allowed = (req: http.IncomingMessage) =>
  !INGRESS_ONLY || INGRESS_ADDRESSES.has(req.socket.remoteAddress ?? '');

const server = http.createServer((req, res) => {
  if (!allowed(req)) {
    res.statusCode = 403;
    return res.end();
  }
  core.handleRequest(req, res, () => serveStatic(req, res));
});

server.on('upgrade', (req, socket, head) => {
  if (!allowed(req) || !core.handleUpgrade(req, socket, head)) socket.destroy();
});

core.startMediaServer();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[groupsync] app on :${PORT}${INGRESS_ONLY ? ' (ingress only)' : ''}, MA ${settings.MA_URL ?? '(not set)'}`);
});
