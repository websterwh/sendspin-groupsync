/**
 * Endpoint helpers shared by the MA and Sendspin websocket clients.
 */

/**
 * Directory the page is served from, ending in '/'. That is '/' normally, but inside Home Assistant the
 * add-on lives under /api/hassio_ingress/<token>/, so every request has to be relative to it.
 */
export function basePath(): string {
  return typeof window === 'undefined' ? '/' : new URL('.', window.location.href).pathname;
}

function parseServer(serverUrl: string): URL {
  let url = serverUrl.trim().replace(/\/$/, '');
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `http://${url}`;
  }
  return new URL(url);
}

/**
 * Build the websocket URL for an MA endpoint ('/ws' or '/sendspin').
 *
 * When the page is HTTPS (needed for mic access on a phone) and MA is plain
 * HTTP, browsers block a direct ws:// connection. In that case we connect
 * wss:// back to the GroupSync dev server, which proxies to MA.
 */
export function buildMaWebSocketUrl(serverUrl: string, path: '/ws' | '/sendspin'): string {
  const parsed = parseServer(serverUrl);
  const pageSecure = typeof window !== 'undefined' && window.location.protocol === 'https:';

  if (parsed.protocol === 'https:') {
    return `wss://${parsed.host}${path}`;
  }
  if (pageSecure) {
    return `wss://${window.location.host}${basePath()}ma-proxy${path}?target=${encodeURIComponent(parsed.host)}`;
  }
  return `ws://${parsed.host}${path}`;
}

/** Sent instead of the real token when it's saved in .env.local; the dev-server proxy swaps it in */
export const ENV_TOKEN_PLACEHOLDER = '__GROUPSYNC_ENV_TOKEN__';

interface DevServerInfo {
  clickTrackUrl?: string | null;
  songUrlBase?: string | null;
  songWavBase?: string | null;
  songStats?: { requests: number; lastAgoS: number | null; lastIp: string; lastName: string };
  tokenSaved?: boolean;
  canSaveToken?: boolean;
  defaultServer?: string | null;
  trackStats?: { requests: number; lastAgoS: number | null; lastIp: string };
}

export async function getDevServerInfo(serverUrl: string): Promise<DevServerInfo | null> {
  try {
    const host = serverUrl.trim() ? parseServer(serverUrl).host : '';
    const res = await fetch(`${basePath()}__groupsync/info?target=${encodeURIComponent(host)}`);
    return res.ok ? ((await res.json()) as DevServerInfo) : null;
  } catch {
    return null; // not served by the GroupSync dev server
  }
}

/** Save (or with null, forget) the MA token in .env.local on the machine running the dev server */
export async function saveTokenToEnv(token: string | null): Promise<boolean> {
  try {
    const res = await fetch(`${basePath()}__groupsync/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Get a URL Music Assistant can fetch the click track from.
 *
 * The dev server exposes the track over plain HTTP on this machine's LAN IP,
 * so no configuration is needed. VITE_MEDIA_BASE_URL overrides it.
 * `seconds` sizes the generated track.
 */
export async function resolveClickTrackUrl(serverUrl: string, seconds?: number): Promise<string> {
  const query = seconds ? `?seconds=${Math.round(seconds)}` : '';
  const override = import.meta.env.VITE_MEDIA_BASE_URL as string | undefined;
  if (override) return `${override.replace(/\/$/, '')}/calibration-clicks.wav${query}`;

  const info = await getDevServerInfo(serverUrl);
  if (info?.clickTrackUrl) return `${info.clickTrackUrl}${query}`;
  return `${window.location.origin}${basePath()}calibration-clicks.wav`;
}

/** Songs in the dev server's groupsync-music folder (song test) */
export async function listSongs(): Promise<string[]> {
  try {
    const res = await fetch(`${basePath()}__groupsync/songs`);
    return res.ok ? ((await res.json()) as string[]) : [];
  } catch {
    return [];
  }
}

/** The file itself, fetched from the page's own server for decoding */
export async function fetchSong(name: string): Promise<ArrayBuffer> {
  const res = await fetch(`${basePath()}__groupsync/song/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`Couldn't load ${name} (${res.status})`);
  return res.arrayBuffer();
}

/**
 * Hand the server the decoded song as a mono 16-bit wav and get back the address Music Assistant plays it
 * from. Playing a wav (like the click track) works on every player, and it is exactly the audio compared against.
 */
export async function uploadSongWav(serverUrl: string, name: string, wav: ArrayBuffer): Promise<string> {
  const info = await getDevServerInfo(serverUrl);
  if (!info?.songWavBase) throw new Error("This server can't offer songs (is it the dev server?)");
  const safe = `${name.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) || 'song'}.wav`;
  const res = await fetch(`${basePath()}__groupsync/songwav?name=${encodeURIComponent(safe)}`, { method: 'POST', body: wav });
  if (!res.ok) throw new Error(`Couldn't hand the song to the server (${res.status})`);
  return `${info.songWavBase}${encodeURIComponent(safe)}`;
}

/** What Music Assistant has asked this server for so far (song test diagnostics) */
export async function getSongStats(serverUrl: string): Promise<{ requests: number; lastAgoS: number | null; lastIp: string } | null> {
  return (await getDevServerInfo(serverUrl))?.songStats ?? null;
}

/** The plain-HTTP address Music Assistant plays the song from */
export async function resolveSongUrl(serverUrl: string, name: string): Promise<string> {
  const info = await getDevServerInfo(serverUrl);
  if (!info?.songUrlBase) throw new Error("This server can't offer songs (is it the dev server?)");
  return `${info.songUrlBase}${encodeURIComponent(name)}`;
}

/** Remember the MA address in .env.local (as MA_URL) so every device pre-fills it */
export async function saveServerToEnv(server: string): Promise<void> {
  try {
    await fetch(`${basePath()}__groupsync/server`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server }),
    });
  } catch {
    // not served by the GroupSync dev server
  }
}

export interface DiagnosticStep {
  label: string;
  ok: boolean;
  detail?: string;
}

/**
 * Check each hop of the connection and report which one fails. Useful on a
 * phone, where there's no console to read.
 */
export async function diagnoseConnection(serverUrl: string): Promise<DiagnosticStep[]> {
  const steps: DiagnosticStep[] = [];
  const parsed = parseServer(serverUrl);

  const info = await getDevServerInfo(serverUrl);
  steps.push({
    label: 'This page can reach the GroupSync dev server',
    ok: !!info,
    detail: info ? undefined : 'Is `npm run dev` still running? Is the page opened from the dev server address?',
  });
  if (!info) return steps;

  try {
    const res = await fetch(`${basePath()}__groupsync/check?target=${encodeURIComponent(parsed.host)}`);
    const body = (await res.json()) as { ok: boolean; error?: string };
    steps.push({
      label: `The computer running the dev server can reach Music Assistant at ${parsed.host}`,
      ok: body.ok,
      detail: body.ok ? undefined : `${body.error ?? 'failed'}. Check the address and port.`,
    });
    if (!body.ok) return steps;
  } catch (e) {
    steps.push({ label: 'Reach Music Assistant from the dev server', ok: false, detail: String(e) });
    return steps;
  }

  const wsUrl = buildMaWebSocketUrl(serverUrl, '/ws');
  const result = await new Promise<{ ok: boolean; detail?: string }>((resolve) => {
    let settled = false;
    const done = (r: { ok: boolean; detail?: string }) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    try {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        ws.close();
        done({ ok: false, detail: 'timed out' });
      }, 5000);
      ws.onmessage = () => {
        clearTimeout(timer);
        ws.close();
        done({ ok: true });
      };
      ws.onerror = () => {
        clearTimeout(timer);
        done({ ok: false, detail: 'the browser could not open the secure websocket' });
      };
    } catch (e) {
      done({ ok: false, detail: String(e) });
    }
  });
  steps.push({
    label: 'This browser can open the secure websocket to the dev server',
    ok: result.ok,
    detail: result.ok
      ? undefined
      : `${result.detail}. On a phone this is usually the self-signed certificate: open https://${window.location.host}/ once and accept the warning, or try Chrome instead of Safari.`,
  });
  return steps;
}
