/**
 * GroupSync server core, shared by the Vite dev server and the Home Assistant add-on:
 *
 * 1. WebSocket proxy  /ma-proxy/<path>?target=host:port
 *    The page is served over HTTPS (needed for the phone mic), and browsers
 *    block ws:// from HTTPS pages. The page connects wss:// back to this server
 *    instead, and we forward to MA's plain ws://. The MA token can live here
 *    (setting MA_TOKEN) and is swapped in for a placeholder, so it never
 *    reaches the browser.
 *
 * 2. Click-track server (plain HTTP, default port 5174)
 *    Music Assistant must fetch the click track itself. /__groupsync/info tells
 *    the page the URL to hand to MA.
 *
 * 3. /__groupsync/info, /check, /token, /server helper endpoints.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { DEFAULT_CALIBRATION_CONFIG } from '../src/types/calibration';

export interface CoreOptions {
  mediaPort: number;
  /** Read a setting: MA_TOKEN, MA_URL, MEDIA_HOST */
  getSetting: (key: string) => string | null;
  /** Write a setting (null removes it). Omit when settings are managed elsewhere, e.g. add-on options. */
  setSetting?: (key: string, value: string | null) => void;
  /** Folder of songs for the dev-only song test; omit to serve none (the add-on does) */
  musicDir?: string;
}

const SONG_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
};

const TRACK_NAME = 'calibration-clicks.wav';
const MAX_TRACK_SECONDS = 600;
const TRACK_RATE = 48000;
const CLICK_MS = 50;
const CLICK_AMPLITUDE = 0.8;

const trackCache = new Map<number, Buffer>();

/** What Music Assistant has requested from the click-track server (shown on the page while waiting) */
const trackStats = { requests: 0, lastAt: 0, lastIp: '', lastRange: '' };
/** Requests for songs on the plain-HTTP media port, i.e. what Music Assistant asked for */
const songStats = { requests: 0, lastAt: 0, lastIp: '', lastName: '', bytes: 0 };

/** Placeholder the page sends instead of the real token; swapped in by the proxy so the token never reaches the browser */
const TOKEN_PLACEHOLDER = '__GROUPSYNC_ENV_TOKEN__';

/** Mono 16-bit click track: one 50 ms Hann-windowed tone burst per interval, cycling frequencies. */
function buildTrack(seconds: number): Buffer {
  const cached = trackCache.get(seconds);
  if (cached) return cached;
  const { frequencies, clickIntervalMs } = DEFAULT_CALIBRATION_CONFIG;
  const total = seconds * TRACK_RATE;
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
  trackCache.set(seconds, buf);
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


export function createGroupSyncCore(options: CoreOptions) {
  const { mediaPort, getSetting, setSetting, musicDir } = options;
  const wss = new WebSocketServer({ noServer: true });
  let mediaServer: http.Server | null = null;

  const handleUpgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (!url.pathname.startsWith('/ma-proxy/')) return false;
    const target = parseTarget(url.searchParams.get('target'));
    if (!target) {
      socket.destroy();
      return true;
    }
    const upstreamPath = url.pathname.slice('/ma-proxy'.length); // /ws or /sendspin
    wss.handleUpgrade(req, socket, head, (client) => {
      const upstream = new WebSocket(`ws://${target.host}:${target.port}${upstreamPath}`);
      const pending: Array<{ data: Buffer; isBinary: boolean }> = [];
      client.on('message', (data, isBinary) => {
        let buf = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]);
        if (!isBinary && buf.includes(TOKEN_PLACEHOLDER)) {
          const saved = getSetting('MA_TOKEN');
          if (saved) buf = Buffer.from(buf.toString().split(TOKEN_PLACEHOLDER).join(saved));
        }
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
    return true;
  };

  const isLoopback = (req: http.IncomingMessage) => {
    const addr = req.socket.remoteAddress ?? '';
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  };

  const readBody = (req: http.IncomingMessage, done: (body: string) => void) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => done(body));
  };

  /** Settings can only be changed from the machine itself, and only when they aren't managed elsewhere */
  const canWrite = (req: http.IncomingMessage) => !!setSetting && isLoopback(req);

  /** Handles /__groupsync/* and the click track; calls next() for anything else */
  const handleRequest = (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? '', 'http://localhost');

    if (url.pathname === `/${TRACK_NAME}`) return serveTrack(req, res, url);
    if (url.pathname === '/__groupsync/songs') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(listSongs()));
    }
    if (url.pathname.startsWith('/__groupsync/song/')) {
      return serveSong(req, res, decodeURIComponent(url.pathname.slice('/__groupsync/song/'.length)));
    }

    if (url.pathname === '/__groupsync/token' && req.method === 'POST') {
      if (!canWrite(req)) {
        res.statusCode = 403;
        return res.end();
      }
      readBody(req, (body) => {
        try {
          const { token } = JSON.parse(body) as { token?: string | null };
          if (token && !/^[A-Za-z0-9._~+/=-]{8,4096}$/.test(token)) throw new Error('bad token');
          setSetting!('MA_TOKEN', token || null);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.statusCode = 400;
          res.end();
        }
      });
      return;
    }
    if (url.pathname === '/__groupsync/server' && req.method === 'POST') {
      if (!canWrite(req)) {
        res.statusCode = 403;
        return res.end();
      }
      readBody(req, (body) => {
        try {
          const { server } = JSON.parse(body) as { server?: string | null };
          if (server && !/^[A-Za-z0-9.:/-]{3,200}$/.test(server)) throw new Error('bad server');
          setSetting!('MA_URL', server || null);
          res.end('{"ok":true}');
        } catch {
          res.statusCode = 400;
          res.end();
        }
      });
      return;
    }
    if (url.pathname === '/__groupsync/check') {
      // Can this machine reach MA's websocket? (separates "wrong address" from "browser can't reach this server")
      const target = parseTarget(url.searchParams.get('target'));
      res.setHeader('Content-Type', 'application/json');
      if (!target) return res.end(JSON.stringify({ ok: false, error: 'invalid address' }));
      const ws = new WebSocket(`ws://${target.host}:${target.port}/ws`);
      const finish = (ok: boolean, error?: string) => {
        clearTimeout(timer);
        ws.removeAllListeners();
        ws.on('error', () => {});
        ws.terminate();
        if (!res.writableEnded) res.end(JSON.stringify({ ok, error }));
      };
      const timer = setTimeout(() => finish(false, 'timed out after 4 s (wrong IP, or a firewall in between)'), 4000);
      ws.on('message', () => finish(true));
      ws.on('error', (e) => finish(false, e.message));
      return;
    }
    if (url.pathname !== '/__groupsync/info') return next();

    const target = parseTarget(url.searchParams.get('target'));
    // MEDIA_HOST overrides the guessed address (needed when MA can't reach this machine's own address)
    const mediaHost = getSetting('MEDIA_HOST') || pickLanIp(target?.host ?? null);
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        songUrlBase: mediaHost && musicDir ? `http://${mediaHost}:${mediaPort}/song/` : null,
        clickTrackUrl: mediaHost ? `http://${mediaHost}:${mediaPort}/${TRACK_NAME}` : null,
        tokenSaved: !!getSetting('MA_TOKEN'),
        defaultServer: getSetting('MA_URL'),
        canSaveToken: canWrite(req),
        songStats: {
          requests: songStats.requests,
          lastAgoS: songStats.lastAt ? Math.round((Date.now() - songStats.lastAt) / 1000) : null,
          lastIp: songStats.lastIp,
          lastName: songStats.lastName,
        },
        trackStats: {
          requests: trackStats.requests,
          lastAgoS: trackStats.lastAt ? Math.round((Date.now() - trackStats.lastAt) / 1000) : null,
          lastIp: trackStats.lastIp,
        },
      })
    );
  };

  const listSongs = (): string[] => {
    if (!musicDir) return [];
    try {
      return fs.readdirSync(musicDir).filter((f) => SONG_TYPES[path.extname(f).toLowerCase()]).sort();
    } catch {
      return [];
    }
  };

  /** Serve one file from the music folder (only names that are in the listing), with byte ranges */
  const serveSong = (req: http.IncomingMessage, res: http.ServerResponse, name: string, fromPlayer = false) => {
    if (!musicDir || !listSongs().includes(name)) {
      res.statusCode = 404;
      return res.end();
    }
    if (fromPlayer) {
      songStats.requests++;
      songStats.lastAt = Date.now();
      songStats.lastIp = (req.socket.remoteAddress ?? '').replace('::ffff:', '');
      songStats.lastName = name;
      console.log(`[groupsync] ${songStats.lastIp} requested song "${name}" ${req.headers.range ?? ''}`);
    }
    const file = path.join(musicDir, name);
    const size = fs.statSync(file).size;
    res.setHeader('Content-Type', SONG_TYPES[path.extname(name).toLowerCase()]);
    res.setHeader('Accept-Ranges', 'bytes');
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
    let start = 0;
    let end = size - 1;
    if (range) {
      if (range[1]) {
        start = Number(range[1]);
        end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      } else if (range[2]) {
        // suffix range: the last N bytes (players read the tags at the end of mp3 files this way)
        start = Math.max(0, size - Number(range[2]));
      }
      if (start >= size || start > end) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${size}`);
        return res.end();
      }
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    res.setHeader('Content-Length', end - start + 1);
    if (req.method === 'HEAD') return res.end();
    if (fromPlayer) {
      let sent = 0;
      res.on('close', () =>
        console.log(`[groupsync] song request ${start}-${end}: sent ${sent} of ${end - start + 1} bytes${res.writableFinished ? '' : ' (the player closed the connection early)'}`)
      );
      const stream = fs.createReadStream(file, { start, end });
      stream.on('data', (c) => (sent += c.length));
      stream.pipe(res);
      return;
    }
    fs.createReadStream(file, { start, end }).pipe(res);
  };

  const serveTrack = (req: http.IncomingMessage, res: http.ServerResponse, reqUrl: URL) => {
    trackStats.requests++;
    trackStats.lastAt = Date.now();
    trackStats.lastIp = (req.socket.remoteAddress ?? '').replace('::ffff:', '');
    trackStats.lastRange = req.headers.range ?? '';
    const wanted = Number(reqUrl.searchParams.get('seconds')) || MAX_TRACK_SECONDS;
    const track = buildTrack(Math.min(MAX_TRACK_SECONDS, Math.max(30, Math.round(wanted))));
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
  };

  const startMediaServer = () => {
    if (mediaServer) return;
    // This port is reachable from the network (Music Assistant fetches the track from it), so it serves
    // the click track and nothing else.
    mediaServer = http.createServer((req, res) => {
      const reqUrl = new URL(req.url ?? '', 'http://localhost');
      if (reqUrl.pathname === `/${TRACK_NAME}`) return serveTrack(req, res, reqUrl);
      if (reqUrl.pathname.startsWith('/song/')) return serveSong(req, res, decodeURIComponent(reqUrl.pathname.slice(6)), true);
      res.statusCode = 404;
      res.end();
    });
    mediaServer.on('error', (e) => console.warn(`[groupsync] media server on :${mediaPort} failed:`, e.message));
    mediaServer.listen(mediaPort, '0.0.0.0', () =>
      console.log(`[groupsync] click track served over plain HTTP on :${mediaPort}`)
    );
  };

  const stopMediaServer = () => {
    mediaServer?.close();
    mediaServer = null;
  };

  return { handleUpgrade, handleRequest, startMediaServer, stopMediaServer };
}
