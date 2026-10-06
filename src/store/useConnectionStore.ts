import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface ConnectionState {
  serverUrl: string;
  sendspinUrl: string;  // Optional separate URL for Sendspin clock sync
  connected: boolean;
  connecting: boolean;
  error: string | null;
  recentServers: string[];
  /** Set when the user disconnects on purpose, so we don't reconnect straight away (not persisted) */
  autoConnectOff: boolean;
}

interface ConnectionActions {
  setServerUrl: (url: string) => void;
  setSendspinUrl: (url: string) => void;
  setConnected: (connected: boolean) => void;
  setConnecting: (connecting: boolean) => void;
  setError: (error: string | null) => void;
  addRecentServer: (url: string) => void;
  setAutoConnectOff: (off: boolean) => void;
  reset: () => void;
}

const initialState: ConnectionState = {
  serverUrl: '',
  sendspinUrl: '',
  connected: false,
  connecting: false,
  error: null,
  recentServers: [],
  autoConnectOff: false,
};

export const useConnectionStore = create<ConnectionState & ConnectionActions>()(
  persist(
    (set, get) => ({
      ...initialState,

      setServerUrl: (url) => set({ serverUrl: url }),

      setSendspinUrl: (url) => set({ sendspinUrl: url }),

      setConnected: (connected) => set({ connected, connecting: false }),

      // Starting a connection clears the old error; finishing one must not wipe a new error
      setConnecting: (connecting) => set(connecting ? { connecting, error: null } : { connecting }),

      setError: (error) => set({ error, connecting: false, connected: false }),

      addRecentServer: (url) => {
        const { recentServers } = get();
        const filtered = recentServers.filter((s) => s !== url);
        set({ recentServers: [url, ...filtered].slice(0, 5) });
      },

      setAutoConnectOff: (off) => set({ autoConnectOff: off }),

      reset: () =>
        set({ ...initialState, serverUrl: get().serverUrl, recentServers: get().recentServers, autoConnectOff: true }),
    }),
    {
      name: 'groupsync-connection',
      partialize: (state) => ({
        serverUrl: state.serverUrl,
        sendspinUrl: state.sendspinUrl,
        recentServers: state.recentServers,
      }),
    }
  )
);
