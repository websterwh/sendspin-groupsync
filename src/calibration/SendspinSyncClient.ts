/**
 * Sendspin Sync Client
 *
 * Minimal Sendspin protocol client for clock synchronization.
 * Connects to the Sendspin WebSocket endpoint and performs NTP-style time sync.
 *
 * Based on the Sendspin protocol implementation in SpinDroid and windowsSpin.
 */

import { ClockSynchronizer, clockSynchronizer } from './ClockSynchronizer';
import { maClient } from '../ma-client';
import { buildMaWebSocketUrl } from '../ma-client/endpoints';

export type SendspinSyncState = 'disconnected' | 'connecting' | 'handshaking' | 'syncing' | 'synced';

interface SendspinMessage {
  type: string;
  payload?: Record<string, unknown>;
  token?: string;
}

interface ServerTimePayload {
  client_transmitted: number;
  server_received: number;
  server_transmitted: number;
}

type StateChangeHandler = (state: SendspinSyncState) => void;

/**
 * Client for clock synchronization with Sendspin server.
 */
export class SendspinSyncClient {
  private ws: WebSocket | null = null;
  private state: SendspinSyncState = 'disconnected';
  private stateHandlers: Set<StateChangeHandler> = new Set();
  private syncInterval: ReturnType<typeof setInterval> | null = null;
  private readonly clockSync: ClockSynchronizer;

  // Client identity
  private readonly clientId: string;
  private readonly clientName: string;

  // Configuration
  private static readonly TIME_SYNC_INTERVAL_MS = 1000;
  private static readonly INITIAL_SYNC_COUNT = 5;
  private static readonly INITIAL_SYNC_DELAY_MS = 100;

  constructor(clientName = 'GroupSync', clockSync?: ClockSynchronizer) {
    this.clientId = this.generateUUID();
    this.clientName = clientName;
    this.clockSync = clockSync ?? clockSynchronizer;
  }

  /**
   * Get current state.
   */
  get currentState(): SendspinSyncState {
    return this.state;
  }

  /**
   * Get the clock synchronizer.
   */
  get clock(): ClockSynchronizer {
    return this.clockSync;
  }

  /**
   * Whether clock sync has converged.
   */
  get isSynced(): boolean {
    return this.clockSync.isConverged;
  }

  /**
   * Connect to the Sendspin server and start clock synchronization.
   *
   * @param serverUrl Base URL of the MA server (e.g., "http://192.168.1.100:8095")
   */
  async connect(serverUrl: string): Promise<void> {
    if (this.ws) {
      this.disconnect();
    }

    this.setState('connecting');
    this.clockSync.reset();

    return new Promise((resolve, reject) => {
      try {
        const wsUrl = this.buildWebSocketUrl(serverUrl);

        this.ws = new WebSocket(wsUrl);

        const timeout = setTimeout(() => {
          reject(new Error('Connection timeout'));
          this.disconnect();
        }, 10000);

        this.ws.onopen = () => {
          clearTimeout(timeout);
          this.setState('handshaking');
          // MA's /sendspin proxy requires {type:'auth', token} as the first frame
          // and answers {type:'auth_ok'} before it will proxy client/hello.
          const token = maClient.token;
          if (token) {
            this.sendMessage({ type: 'auth', token });
          } else {
            this.sendClientHello();
          }
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);

          // Resolve when handshake completes
          if (this.state === 'syncing' || this.state === 'synced') {
            resolve();
          }
        };

        this.ws.onerror = (error) => {
          console.error('[SendspinSync] WebSocket error:', error);
          console.error('[SendspinSync] URL was:', wsUrl);
          clearTimeout(timeout);
          reject(new Error(`WebSocket connection failed to ${wsUrl}`));
        };

        this.ws.onclose = () => {
          this.stopSyncLoop();
          this.setState('disconnected');
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the server.
   */
  disconnect(): void {
    this.stopSyncLoop();

    if (this.ws) {
      this.sendGoodbye();
      this.ws.close();
      this.ws = null;
    }

    this.setState('disconnected');
  }

  /**
   * Subscribe to state changes.
   */
  onStateChange(handler: StateChangeHandler): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  /**
   * Wait for clock synchronization to converge.
   *
   * @param timeoutMs Maximum time to wait for convergence
   */
  async waitForSync(timeoutMs = 5000): Promise<boolean> {
    if (this.clockSync.isConverged) {
      return true;
    }

    return new Promise((resolve) => {
      const startTime = Date.now();

      const checkSync = () => {
        if (this.clockSync.isConverged) {
          resolve(true);
          return;
        }

        if (Date.now() - startTime >= timeoutMs) {
          resolve(false);
          return;
        }

        setTimeout(checkSync, 100);
      };

      checkSync();
    });
  }

  // ==================== Private Methods ====================

  private setState(state: SendspinSyncState): void {
    if (this.state === state) return;

    this.state = state;

    this.stateHandlers.forEach((handler) => {
      try {
        handler(state);
      } catch (error) {
        console.error('[SendspinSync] State handler error:', error);
      }
    });
  }

  private buildWebSocketUrl(serverUrl: string): string {
    return buildMaWebSocketUrl(serverUrl, '/sendspin');
  }

  private generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data) as SendspinMessage;

      switch (message.type) {
        case 'auth_ok':
          this.sendClientHello();
          break;

        case 'server/hello':
          if (message.payload) {
            this.handleServerHello();
          }
          break;

        case 'server/time':
          if (message.payload) {
            this.handleServerTime(message.payload as unknown as ServerTimePayload);
          }
          break;

        default:
          // Ignore other message types - we only care about time sync
          break;
      }
    } catch (error) {
      console.error('[SendspinSync] Failed to parse message:', error);
    }
  }

  private handleServerHello(): void {
    this.setState('syncing');
    this.startSyncLoop();
  }

  private handleServerTime(payload: ServerTimePayload): void {
    const t4 = this.clockSync.getCurrentTimeMicroseconds();

    this.clockSync.processMeasurement(
      payload.client_transmitted,
      payload.server_received,
      payload.server_transmitted,
      t4
    );

    // Update state when converged
    if (this.clockSync.isConverged && this.state === 'syncing') {
      this.setState('synced');
    }
  }

  private sendMessage(message: SendspinMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[SendspinSync] Cannot send - WebSocket not open');
      return;
    }

    this.ws.send(JSON.stringify(message));
  }

  private sendClientHello(): void {
    const message: SendspinMessage = {
      type: 'client/hello',
      payload: {
        client_id: this.clientId,
        name: this.clientName,
        version: 1,
        supported_roles: ['controller@v1'],  // Minimal - just for time sync
        device_info: {
          product_name: 'GroupSync',
          manufacturer: 'Sendspin',
          software_version: '1.0.0',
        },
      },
    };

    this.sendMessage(message);
  }

  private sendGoodbye(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.sendMessage({
      type: 'client/goodbye',
      payload: { reason: 'calibration_complete' },
    });
  }

  private sendClientTime(): void {
    const t1 = this.clockSync.getCurrentTimeMicroseconds();

    this.sendMessage({
      type: 'client/time',
      payload: { client_transmitted: t1 },
    });
  }

  private startSyncLoop(): void {
    this.stopSyncLoop();

    // Send initial rapid syncs
    let initialSyncCount = 0;
    const sendInitialSync = () => {
      if (initialSyncCount < SendspinSyncClient.INITIAL_SYNC_COUNT) {
        this.sendClientTime();
        initialSyncCount++;
        setTimeout(sendInitialSync, SendspinSyncClient.INITIAL_SYNC_DELAY_MS);
      }
    };
    sendInitialSync();

    // Then periodic syncs
    this.syncInterval = setInterval(() => {
      this.sendClientTime();
    }, SendspinSyncClient.TIME_SYNC_INTERVAL_MS);
  }

  private stopSyncLoop(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }
}

// Factory function
export function createSendspinSyncClient(
  clientName?: string,
  clockSync?: ClockSynchronizer
): SendspinSyncClient {
  return new SendspinSyncClient(clientName, clockSync);
}
