/**
 * SyncOffsetPusher - Writes the suggested delay values back to Music Assistant.
 *
 * Each result carries the setting that actually shifts that player (see delaySettings.ts), so the
 * value goes to the right place: e.g. the Sendspin static delay on a Chromecast's Sendspin protocol
 * player, or the generic sync_adjust. Results without a known setting are skipped.
 */

import { maClient } from '../ma-client';
import type { CalibrationResult } from '../types';

export interface PushResult {
  playerId: string;
  playerName: string;
  success: boolean;
  method: 'config' | 'none';
  appliedOffsetMs: number;
  error?: string;
}

export interface PushOptions {
  /** Timeout for each push operation in ms */
  timeoutMs?: number;
}

const DEFAULT_OPTIONS: PushOptions = { timeoutMs: 5000 };

/**
 * Push suggested values to multiple players
 */
export async function pushSyncOffsets(
  results: Record<string, CalibrationResult>,
  options: PushOptions = {}
): Promise<PushResult[]> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const pushResults: PushResult[] = [];

  for (const [playerId, result] of Object.entries(results)) {
    pushResults.push(await pushSingleOffset(playerId, result, opts));
  }
  return pushResults;
}

async function pushSingleOffset(
  playerId: string,
  result: CalibrationResult,
  options: PushOptions
): Promise<PushResult> {
  const base: PushResult = {
    playerId,
    playerName: result.playerName,
    success: false,
    method: 'none',
    appliedOffsetMs: result.offsetMs,
  };

  if (!maClient.isConnected) return { ...base, error: 'Not connected to Music Assistant' };
  const setting = result.setting;
  if (!setting) return { ...base, error: 'No delay setting found for this player in Music Assistant' };

  const value = Math.max(setting.min, Math.min(setting.max, Math.round(result.offsetMs)));
  try {
    await maClient.sendCommand(
      'config/players/save',
      { player_id: setting.configPlayerId, values: { [setting.key]: value } },
      options.timeoutMs
    );
    return { ...base, success: true, method: 'config', appliedOffsetMs: value };
  } catch (error) {
    console.error(`[SyncPush] Failed for ${result.playerName}:`, error);
    return { ...base, error: error instanceof Error ? error.message : 'Config save failed' };
  }
}

/**
 * Create the sync offset pusher instance
 */
export function createSyncOffsetPusher() {
  return {
    pushOffsets: pushSyncOffsets,
    pushSingleOffset: async (playerId: string, result: CalibrationResult) =>
      pushSingleOffset(playerId, result, DEFAULT_OPTIONS),
  };
}

export const syncOffsetPusher = createSyncOffsetPusher();
