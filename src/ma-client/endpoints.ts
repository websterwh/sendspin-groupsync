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
  defaultServer?: string | null;
}

export async function getDevServerInfo(serverUrl: string): Promise<DevServerInfo | null> {
  try {
    const host = serverUrl.trim() ? parseServer(serverUrl).host : '';
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

/** Remember the MA address in .env.local (as MA_URL) so every device pre-fills it */
export async function saveServerToEnv(server: string): Promise<void> {
  try {
    await fetch('/__groupsync/server', {
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
    const res = await fetch(`/__groupsync/check?target=${encodeURIComponent(parsed.host)}`);
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
