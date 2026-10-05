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

/**
 * Get a URL Music Assistant can fetch the click track from.
 *
 * The dev server exposes the track over plain HTTP on this machine's LAN IP,
 * so no configuration is needed. VITE_MEDIA_BASE_URL overrides it.
 */
export async function resolveClickTrackUrl(serverUrl: string): Promise<string> {
  const override = import.meta.env.VITE_MEDIA_BASE_URL as string | undefined;
  if (override) return `${override.replace(/\/$/, '')}/calibration-clicks.wav`;

  try {
    const host = parseServer(serverUrl).host;
    const res = await fetch(`/__groupsync/info?target=${encodeURIComponent(host)}`);
    if (res.ok) {
      const info = (await res.json()) as { clickTrackUrl?: string | null };
      if (info.clickTrackUrl) return info.clickTrackUrl;
    }
  } catch {
    // Not served by the GroupSync dev server; fall through
  }
  return `${window.location.origin}/calibration-clicks.wav`;
}
