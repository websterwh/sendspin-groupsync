/**
 * GroupSync dev-server helpers (no extra setup needed):
 *
 * 1. WebSocket proxy  /ma-proxy/<path>?target=host:port
 *    The page is served over HTTPS (needed for the phone mic), and browsers
 *    block ws:// from HTTPS pages. The page connects wss:// to this server
 *    instead, and we forward to MA's plain ws://.
 *
 * 2. Plain-HTTP click-track server (default port 5174)
 *    Music Assistant must fetch the click track itself, and it can't trust the
 *    self-signed dev cert. /__groupsync/info?target=host:port tells the page
 *    the http:// URL (using this machine's LAN IP on MA's subnet).
 */
import http from 'node:http';
import os from 'node:os';
import type { Duplex } from 'node:stream';
import type { Plugin } from 'vite';
import { WebSocket, WebSocketServer } from 'ws';
import { DEFAULT_CALIBRATION_CONFIG } from './src/types/calibration';

const MEDIA_PORT = Number(process.env.GROUPSYNC_MEDIA_PORT ?? 5174);
const TRACK_NAME = 'calibration-clicks.wav';
const TRACK_SECONDS = 300;
const TRACK_RATE = 48000;
const CLICK_MS = 50;
const CLICK_AMPLITUDE = 0.8;

let cachedTrack: Buffer | null = null;

/** Mono 16-bit click track: one 50 ms Hann-windowed tone burst per interval, cycling frequencies. */
function buildTrack(): Buffer {
  if (cachedTrack) return cachedTrack;
  const { frequencies, clickIntervalMs } = DEFAULT_CALIBRATION_CONFIG;
  const total = TRACK_SECONDS * TRACK_RATE;
  const clickSamples = Math.floor((CLICK_MS / 1000) * TRACK_RATE);
  const interval = Math.floor((clickIntervalMs / 1000) * TRACK_RATE);
  const buf = Buffer.alloc(44 + total * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + total * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(TRACK_RATE, 24);
  buf.writeUInt32LE(TRACK_RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(total * 2, 40);
  for (let click = 0; click * interval + clickSamples < total; click++) {
    const freq = frequencies[click % frequencies.length];
    for (let i = 0; i < clickSamples; i++) {
      const env = 0.5 * (1 - Math.cos((2 * Math.PI * i) / clickSamples));
      const v = CLICK_AMPLITUDE * env * Math.sin((2 * Math.PI * freq * i) / TRACK_RATE);
      buf.writeInt16LE(Math.round(v * 0x7fff), 44 + (click * interval + i) * 2);
    }
  }
  cachedTrack = buf;
  return buf;
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

/** Prefer the local IP sharing a /24 with the target host. */
function pickLanIp(targetHost: string | null): string | null {
  const ips = lanAddresses();
  if (targetHost) {
    const prefix = targetHost.split('.').slice(0, 3).join('.');
    const match = ips.find((ip) => ip.startsWith(`${prefix}.`));
    if (match) return match;
  }
  return ips[0] ?? null;
}

function parseTarget(raw: string | null): { host: string; port: string } | null {
  if (!raw || !/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(raw)) return null;
  const [host, port = '8095'] = raw.split(':');
  return { host, port };
}

export function groupSyncPlugin(): Plugin {
  const wss = new WebSocketServer({ noServer: true });
  let mediaServer: http.Server | null = null;

  const handleUpgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (!url.pathname.startsWith('/ma-proxy/')) return;
    const target = parseTarget(url.searchParams.get('target'));
    if (!target) {
      socket.destroy();
      return;
    }
    const upstreamPath = url.pathname.slice('/ma-proxy'.length); // /ws or /sendspin
    wss.handleUpgrade(req, socket, head, (client) => {
      const upstream = new WebSocket(`ws://${target.host}:${target.port}${upstreamPath}`);
      const pending: Array<{ data: Buffer; isBinary: boolean }> = [];
      client.on('message', (data, isBinary) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]);
        if (upstream.readyState === WebSocket.OPEN) upstream.send(buf, { binary: isBinary });
        else pending.push({ data: buf, isBinary });
      });
      upstream.on('open', () => {
        for (const m of pending) upstream.send(m.data, { binary: m.isBinary });
        pending.length = 0;
      });
      upstream.on('message', (data, isBinary) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]);
        if (client.readyState === WebSocket.OPEN) client.send(buf, { binary: isBinary });
      });
      // Close codes below 1000/1005/1006 aren't valid to send, so only forward usable ones.
      const closeWith = (ws: WebSocket) => (code: number, reason: Buffer) => {
        const valid = code >= 1000 && code !== 1005 && code !== 1006 && code !== 1015;
        if (ws.readyState <= WebSocket.OPEN) ws.close(valid ? code : 1011, reason.toString().slice(0, 120));
      };
      client.on('close', closeWith(upstream));
      upstream.on('close', closeWith(client));
      client.on('error', () => upstream.terminate());
      upstream.on('error', () => client.close(1011, 'upstream error'));
    });
  };

  const handleInfo = (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname !== '/__groupsync/info') return next();
    const target = parseTarget(url.searchParams.get('target'));
    const ip = pickLanIp(target?.host ?? null);
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        clickTrackUrl: ip ? `http://${ip}:${MEDIA_PORT}/${TRACK_NAME}` : null,
      })
    );
  };

  const startMediaServer = () => {
    if (mediaServer) return;
    mediaServer = http.createServer((req, res) => {
      if (req.url?.split('?')[0] !== `/${TRACK_NAME}`) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const track = buildTrack();
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Accept-Ranges', 'bytes');
      const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
      if (range) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]), track.length - 1) : track.length - 1;
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${track.length}`);
        res.setHeader('Content-Length', end - start + 1);
        return req.method === 'HEAD' ? res.end() : res.end(track.subarray(start, end + 1));
      }
      res.setHeader('Content-Length', track.length);
      if (req.method === 'HEAD') return res.end();
      res.end(track);
    });
    mediaServer.on('error', (e) => console.warn(`[groupsync] media server on :${MEDIA_PORT} failed:`, e.message));
    mediaServer.listen(MEDIA_PORT, '0.0.0.0', () =>
      console.log(`[groupsync] click track served over plain HTTP on :${MEDIA_PORT}`)
    );
  };

  return {
    name: 'groupsync',
    configureServer(server) {
      startMediaServer();
      server.middlewares.use(handleInfo);
      server.httpServer?.on('upgrade', handleUpgrade);
      server.httpServer?.on('close', () => mediaServer?.close());
    },
    configurePreviewServer(server) {
      startMediaServer();
      server.middlewares.use(handleInfo);
      server.httpServer?.on('upgrade', handleUpgrade);
      server.httpServer?.on('close', () => mediaServer?.close());
    },
  };
}
