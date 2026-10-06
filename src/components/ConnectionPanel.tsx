import { useEffect, useRef, useState } from 'react';
import { useConnectionStore, usePlayersStore, useAppStore } from '../store';
import { maClient, saveTokenToEnv, getDevServerInfo, saveServerToEnv, diagnoseConnection } from '../ma-client';
import type { DiagnosticStep } from '../ma-client';

export function ConnectionPanel() {
  const {
    serverUrl,
    setServerUrl,
    connecting,
    setConnecting,
    setConnected,
    setError,
    error,
    recentServers,
    addRecentServer,
    autoConnectOff,
    setAutoConnectOff,
  } = useConnectionStore();
  const { setPlayers, setLoading } = usePlayersStore();
  const [inputUrl, setInputUrl] = useState(serverUrl || '');
  const [needsAuth, setNeedsAuth] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authenticating, setAuthenticating] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [saveToEnv, setSaveToEnv] = useState(false);
  const [autoConnecting, setAutoConnecting] = useState(false);
  const triedAuto = useRef(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticStep[] | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [canSaveToEnv, setCanSaveToEnv] = useState(false);

  // Not the first launch: if the address and a token are already saved, connect without asking
  useEffect(() => {
    if (triedAuto.current || autoConnectOff) return;
    triedAuto.current = true;
    (async () => {
      const info = await getDevServerInfo(serverUrl);
      const url = (serverUrl || info?.defaultServer || '').trim();
      if (!url) return;
      let hasToken = false;
      try {
        hasToken = !!localStorage.getItem('ma_access_token');
      } catch {
        // ignore
      }
      if (!hasToken && !info?.tokenSaved) {
        setInputUrl(url);
        return;
      }
      setAutoConnecting(true);
      try {
        await handleConnect(url);
      } finally {
        setAutoConnecting(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pre-fill the address saved on the dev-server machine (so a phone doesn't need it typed)
  useEffect(() => {
    if (inputUrl) return;
    getDevServerInfo('').then((info) => {
      if (info?.defaultServer) setInputUrl((current) => current || info.defaultServer!);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!needsAuth) return;
    getDevServerInfo(inputUrl || serverUrl).then((info) => setCanSaveToEnv(!!info?.canSaveToken));
  }, [needsAuth, inputUrl, serverUrl]);

  const fetchPlayers = async (): Promise<boolean> => {
    setLoading(true);
    try {
      const players = await maClient.getAllPlayers();
      console.log('[MA] Found players:', players.length, players);
      // Show all available players - user can select which ones to calibrate
      setPlayers(players);
      return true;
    } catch (playerError) {
      console.error('[MA] Failed to fetch players:', playerError);
      // Check if this is an auth error
      const errorMsg = playerError instanceof Error ? playerError.message : '';
      if (errorMsg.toLowerCase().includes('auth')) {
        setNeedsAuth(true);
        return false;
      }
      setError(errorMsg || 'Failed to fetch players');
      return false;
    } finally {
      setLoading(false);
    }
  };

  const handleConnect = async (urlOverride?: string) => {
    const target = (urlOverride ?? inputUrl).trim();
    if (!target) return;

    setConnecting(true);
    setError(null);
    setDiagnostics(null);
    setNeedsAuth(false);

    try {
      // Connect to Music Assistant
      await maClient.connect(target);

      // Save URLs
      setServerUrl(target);
      addRecentServer(target);
      void saveServerToEnv(target);

      // Token saved in .env.local on the dev-server machine (never sent to the browser)
      const authedFromEnv = await maClient.authenticateWithServerToken();

      // Try to authenticate with stored token (proactively, some servers require it)
      const hasStoredToken = localStorage.getItem('ma_access_token');
      if (!authedFromEnv && (maClient.needsAuth || hasStoredToken)) {
        const tokenAuthSuccess = await maClient.authenticateWithToken();
        if (!tokenAuthSuccess && maClient.needsAuth) {
          // Server explicitly requires auth and token failed
          setNeedsAuth(true);
          setConnecting(false);
          return;
        }
      }

      // Try to fetch players - this will detect if auth is actually required
      const success = await fetchPlayers();
      if (success) {
        setAutoConnectOff(false);
        useAppStore.getState().setScreen('home');
        setConnected(true);
      }
      // If fetchPlayers failed due to auth, needsAuth is already set
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed';

      setError(message);
      console.error('[MA] Connection error:', err);
      // No console on a phone: say which hop is failing
      setDiagnosing(true);
      diagnoseConnection(target)
        .then(setDiagnostics)
        .finally(() => setDiagnosing(false));
    } finally {
      setConnecting(false);
    }
  };

  const handleLogin = async () => {
    if (!username.trim()) return;

    setAuthenticating(true);
    setError(null);

    try {
      await maClient.login(username, password);
      setConnected(true);
      setNeedsAuth(false);
      await fetchPlayers();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed';
      setError(message);
      console.error('[MA] Login error:', err);
    } finally {
      setAuthenticating(false);
    }
  };

  const handleTokenLogin = async () => {
    const token = tokenInput.trim();
    if (!token) return;

    setAuthenticating(true);
    setError(null);

    try {
      const ok = await maClient.authenticateWithToken(token);
      if (!ok) {
        setError('Token was rejected by Music Assistant. Create a new long-lived token and try again.');
        return;
      }
      if (saveToEnv) {
        const saved = await saveTokenToEnv(token);
        if (!saved) setError('Connected, but the token could not be saved to .env.local.');
      }
      setTokenInput('');
      setNeedsAuth(false);
      if (await fetchPlayers()) {
        setConnected(true);
      }
    } finally {
      setAuthenticating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (needsAuth) {
        if (username.trim() && !authenticating) {
          handleLogin();
        }
      } else if (inputUrl.trim() && !connecting) {
        handleConnect();
      }
    }
  };

  if (autoConnecting && !needsAuth) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-text-muted">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        <p>Connecting…</p>
      </div>
    );
  }

  // Show login form if authentication is required
  if (needsAuth) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold text-center">Log in</h2>

        <div className="space-y-4">
          <div>
            <label htmlFor="username" className="block text-sm font-medium mb-2">
              Username
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="admin"
              disabled={authenticating}
              autoComplete="username"
              className="w-full px-4 py-3 bg-surface border border-gray-600 rounded-lg
                         focus:ring-2 focus:ring-primary focus:border-transparent
                         placeholder-gray-500 disabled:opacity-50"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium mb-2">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Password"
              disabled={authenticating}
              autoComplete="current-password"
              className="w-full px-4 py-3 bg-surface border border-gray-600 rounded-lg
                         focus:ring-2 focus:ring-primary focus:border-transparent
                         placeholder-gray-500 disabled:opacity-50"
            />
          </div>

          <div className="text-center text-xs text-text-muted">or</div>

          <div>
            <label htmlFor="token" className="block text-sm font-medium mb-2">
              Access token
            </label>
            <input
              id="token"
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && tokenInput.trim() && !authenticating) handleTokenLogin();
              }}
              placeholder="Paste token"
              disabled={authenticating}
              autoComplete="off"
              className="w-full px-4 py-3 bg-surface border border-gray-600 rounded-lg
                         focus:ring-2 focus:ring-primary focus:border-transparent
                         placeholder-gray-500 disabled:opacity-50"
            />
            <p className="mt-1 text-xs text-text-muted">
              In Music Assistant: profile &rarr; Access tokens. Stored only in this browser.
            </p>
            {canSaveToEnv && (
              <label className="mt-2 flex items-start gap-2 text-xs text-text-muted">
                <input
                  type="checkbox"
                  checked={saveToEnv}
                  onChange={(e) => setSaveToEnv(e.target.checked)}
                  className="mt-0.5"
                />
                <span>Save on this computer (.env.local) so other devices don&apos;t need it</span>
              </label>
            )}
            <button
              onClick={handleTokenLogin}
              disabled={authenticating || !tokenInput.trim()}
              className="mt-2 w-full py-3 px-4 bg-primary hover:bg-primary-dark disabled:opacity-50
                         rounded-lg font-medium transition-colors"
            >
              Connect with token
            </button>
          </div>

          {error && (
            <div className="p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-300 text-sm">
              {error}
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={() => {
                setNeedsAuth(false);
                maClient.disconnect();
              }}
              disabled={authenticating}
              className="flex-1 py-3 px-4 bg-surface hover:bg-gray-700 disabled:opacity-50
                         rounded-lg font-medium transition-colors"
            >
              Back
            </button>
            <button
              onClick={handleLogin}
              disabled={authenticating || !username.trim()}
              className="flex-1 py-3 px-4 bg-primary hover:bg-primary-dark disabled:opacity-50
                         rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
            >
              {authenticating ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Logging in...
                </>
              ) : (
                'Login'
              )}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-center">Connect</h2>

      <div className="space-y-4">
        <div>
          <label htmlFor="server-url" className="block text-sm font-medium mb-2">
            Server URL
          </label>
          <input
            id="server-url"
            type="text"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="192.168.1.100:8095"
            disabled={connecting}
            className="w-full px-4 py-3 bg-surface border border-gray-600 rounded-lg
                       focus:ring-2 focus:ring-primary focus:border-transparent
                       placeholder-gray-500 disabled:opacity-50"
          />
        </div>

        {error && (
          <div className="p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-300 text-sm">
            {error}
          </div>
        )}

        {(diagnosing || diagnostics) && (
          <div className="p-3 bg-surface border border-gray-600 rounded-lg text-sm space-y-2">
                        {diagnosing && <p className="text-text-muted">Checking...</p>}
            {diagnostics?.map((step) => (
              <div key={step.label}>
                <span>{step.ok ? '✅' : '❌'} {step.label}</span>
                {step.detail && <p className="text-xs text-text-muted ml-6">{step.detail}</p>}
              </div>
            ))}
          </div>
        )}

        <button
          onClick={() => handleConnect()}
          disabled={connecting || !inputUrl.trim()}
          className="w-full py-3 px-4 bg-primary hover:bg-primary-dark disabled:opacity-50
                     rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
        >
          {connecting ? (
            <>
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Connecting...
            </>
          ) : (
            'Connect'
          )}
        </button>
      </div>

      {recentServers.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-text-muted mb-2">Recent Servers</h3>
          <div className="space-y-2">
            {recentServers.map((url) => (
              <button
                key={url}
                onClick={() => setInputUrl(url)}
                disabled={connecting}
                className="w-full text-left px-4 py-2 bg-surface hover:bg-gray-700
                           rounded-lg text-sm transition-colors disabled:opacity-50"
              >
                {url}
              </button>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}
