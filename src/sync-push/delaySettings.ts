/**
 * Find the Music Assistant setting that actually shifts a player's timing.
 *
 * - "Sendspin static delay" (key sendspin_static_delay, 0..5000 ms) lives on the Sendspin protocol
 *   player (for a Chromecast running Sendspin, that is a separate "protocol player" under the device).
 *   Per MA's docs it is compensation for output latency: a HIGHER value makes the player play EARLIER.
 * - The generic "sync_adjust" (-500..500 ms) is the fallback. Which way it moves the sound is not
 *   verified, so it is assumed that a higher value delays the player.
 */

import { maClient } from '../ma-client';
import type { DelaySetting } from '../types';

export type { DelaySetting };

export async function findDelaySetting(playerId: string): Promise<DelaySetting | null> {
  // Candidate config owners: the player itself, then its (non-native) output protocol players
  let protocolIds: string[] = [];
  try {
    const player = await maClient.getPlayer(playerId);
    protocolIds = (player.output_protocols ?? [])
      .filter((p) => !p.is_native && p.output_protocol_id && p.output_protocol_id !== 'native')
      .map((p) => p.output_protocol_id);
  } catch {
    // fall back to the player's own config
  }
  const owners = [playerId, ...protocolIds];

  const configs = new Map<string, Record<string, unknown> | null>();
  for (const id of owners) configs.set(id, await maClient.getPlayerConfigValues(id));

  for (const id of owners) {
    const values = configs.get(id);
    if (values && 'sendspin_static_delay' in values) {
      const current = Number(values.sendspin_static_delay ?? 0);
      return {
        label: 'Sendspin static delay',
        configPlayerId: id,
        key: 'sendspin_static_delay',
        current: Number.isFinite(current) ? current : 0,
        min: 0,
        max: 5000,
        higherIsEarlier: true,
        directionVerified: true,
      };
    }
  }

  const own = configs.get(playerId);
  if (own && 'sync_adjust' in own) {
    const current = Number(own.sync_adjust ?? 0);
    return {
      label: 'Sync delay (sync_adjust)',
      configPlayerId: playerId,
      key: 'sync_adjust',
      current: Number.isFinite(current) ? current : 0,
      min: -500,
      max: 500,
      higherIsEarlier: false,
      directionVerified: false,
    };
  }
  return null;
}

/**
 * New value for a setting so the player plays `earlierByMs` earlier (negative = later),
 * clamped to the setting's range. `clamped` is true if the range stopped it short.
 */
export function suggestValue(setting: DelaySetting, earlierByMs: number): { value: number; clamped: boolean } {
  const wanted = Math.round(setting.current + (setting.higherIsEarlier ? earlierByMs : -earlierByMs));
  const value = Math.max(setting.min, Math.min(setting.max, wanted));
  return { value, clamped: value !== wanted };
}
