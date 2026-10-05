/**
 * Endpoint helpers shared by the MA and Sendspin websocket clients.
 */

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
    return `wss://${window.location.host}/ma-proxy${path}?target=${encodeURIComponent(parsed.host)}`;
  }
  return `ws://${parsed.host}${path}`;
}

/** Sent instead of the real token when it's saved in .env.local; the dev-server proxy swaps it in */
export const ENV_TOKEN_PLACEHOLDER = '__GROUPSYNC_ENV_TOKEN__';

interface DevServerInfo {
  clickTrackUrl?: string | null;
  tokenSaved?: boolean;
  canSaveToken?: boolean;
}

export async function getDevServerInfo(serverUrl: string): Promise<DevServerInfo | null> {
  try {
    const host = parseServer(serverUrl).host;
    const res = await fetch(`/__groupsync/info?target=${encodeURIComponent(host)}`);
    return res.ok ? ((await res.json()) as DevServerInfo) : null;
  } catch {
    return null; // not served by the GroupSync dev server
  }
}

/** Save (or with null, forget) the MA token in .env.local on the machine running the dev server */
export async function saveTokenToEnv(token: string | null): Promise<boolean> {
  try {
    const res = await fetch('/__groupsync/token', {
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
  return `${window.location.origin}/calibration-clicks.wav`;
}
