/**
 * Muting players during a measurement, and putting them back afterwards.
 *
 * Two kinds of problem are reported separately:
 *  - failed: Music Assistant rejected the command (e.g. the player can't be muted)
 *  - unconfirmed: the command was accepted but MA still reports the player as unmuted after a few
 *    seconds. Many players (Sonos, Cast, Sendspin devices) take a while to report a change, or never
 *    report it, so this is only a warning: the player is often muted anyway.
 */

import { maClient } from '../ma-client';

export interface MuteRoom {
  playerId: string;
  name: string;
  /** Mute state before the test; restored afterwards */
  muted?: boolean;
  /** Volume (0-100) before the test, where the session keeps track of it */
  volume?: number;
}

export interface MuteProblem {
  name: string;
  reason: string;
  /** true = Music Assistant rejected the command; false = just couldn't confirm it */
  hard: boolean;
}

/** How long to wait for MA to report a mute before giving up on confirming it */
const CONFIRM_TIMEOUT_MS = 4000;
const POLL_MS = 500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class MuteController {
  private rooms: MuteRoom[];
  private onProblems: (problems: MuteProblem[]) => void;
  private problems = new Map<string, MuteProblem>();
  private changed = false;
  /** Players that never showed a mute in MA even though the command worked: don't wait for them again */
  private unreportable = new Set<string>();

  constructor(rooms: MuteRoom[], onProblems: (problems: MuteProblem[]) => void) {
    this.rooms = rooms;
    this.onProblems = onProblems;
  }

  /**
   * Read each room's mute state and volume as Music Assistant shows them right now. The player list the
   * page holds can be old (a speaker unmuted by hand since, say), and "restore" would then put it back wrongly.
   */
  async refresh(): Promise<void> {
    await Promise.all(
      this.rooms.map(async (room) => {
        try {
          const p = await maClient.getPlayer(room.playerId);
          const muted = p.volume_muted ?? p.muted;
          if (typeof muted === 'boolean') room.muted = muted;
          if (typeof p.volume_level === 'number') room.volume = p.volume_level;
        } catch {
          // keep what we were given
        }
      })
    );
  }

  /** Mute exactly the rooms in `mutedIds` and unmute the rest. Resolves with the hard failures. */
  async set(mutedIds: Set<string>): Promise<MuteProblem[]> {
    const hard: MuteProblem[] = [];
    await Promise.all(
      this.rooms.map(async (room) => {
        const shouldMute = mutedIds.has(room.playerId);
        try {
          await maClient.playerCommand(room.playerId, 'volume_mute', { muted: shouldMute });
          this.changed = true;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          console.warn('[Mute] Could not set mute for', room.name, reason);
          if (shouldMute) hard.push({ name: room.name, reason, hard: true });
        }
      })
    );
    const hardNames = new Set(hard.map((h) => h.name));
    const unconfirmed = await this.confirm(this.rooms.filter((r) => mutedIds.has(r.playerId) && !hardNames.has(r.name)));
    // A speaker that should be playing but still shows as muted (Sonos over AirPlay sometimes ignores the unmute)
    const stuckMuted = await this.ensureUnmuted(this.rooms.filter((r) => !mutedIds.has(r.playerId)));
    this.report([...hard, ...unconfirmed, ...stuckMuted]);
    return hard;
  }

  /** Put every room back to the mute state it had before the test. */
  async restore(): Promise<void> {
    if (!this.changed) return;
    this.changed = false;
    await Promise.all(
      this.rooms.map((room) =>
        maClient.playerCommand(room.playerId, 'volume_mute', { muted: room.muted ?? false }).catch((error) => {
          console.warn('[Mute] Could not restore mute for', room.name, error);
        })
      )
    );
    // Check the speakers that were playing before are playing again, and try once more if not
    const shouldBePlaying = this.rooms.filter((r) => !r.muted);
    const stuck = await this.ensureUnmuted(shouldBePlaying, 'still muted after the test');
    if (stuck.length) this.report(stuck);
  }

  /**
   * Make sure these rooms show as unmuted: look, send the unmute again once if any still show muted, look again.
   * Returns the ones that stay muted, as problems.
   */
  private async ensureUnmuted(rooms: MuteRoom[], what = "wouldn't unmute"): Promise<MuteProblem[]> {
    if (rooms.length === 0) return [];
    let stuck = await this.stillMuted(rooms);
    if (stuck.length === 0) return [];
    await Promise.all(stuck.map((r) => maClient.playerCommand(r.playerId, 'volume_mute', { muted: false }).catch(() => undefined)));
    stuck = await this.stillMuted(stuck);
    return stuck.map((r) => ({ name: r.name, reason: `${what}: unmute it in Music Assistant`, hard: true }));
  }

  /** Rooms that Music Assistant still shows as muted after a short wait (nothing reported counts as fine) */
  private async stillMuted(rooms: MuteRoom[]): Promise<MuteRoom[]> {
    let pending = rooms;
    const deadline = Date.now() + 2500;
    await sleep(400);
    while (pending.length > 0) {
      const checked = await Promise.all(
        pending.map(async (r) => {
          try {
            const p = await maClient.getPlayer(r.playerId);
            return (p.volume_muted ?? p.muted) === true ? r : null;
          } catch {
            return null;
          }
        })
      );
      pending = checked.filter((r): r is MuteRoom => r !== null);
      if (pending.length === 0 || Date.now() > deadline) break;
      await sleep(POLL_MS);
    }
    return pending;
  }

  /** Wait (up to a few seconds) for MA to show each room as muted. Rooms that don't report are unconfirmed. */
  private async confirm(rooms: MuteRoom[]): Promise<MuteProblem[]> {
    const pending = new Set(rooms.filter((r) => !this.unreportable.has(r.playerId)).map((r) => r.playerId));
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    await sleep(300);
    while (pending.size > 0 && Date.now() < deadline) {
      await Promise.all(
        Array.from(pending).map(async (id) => {
          try {
            const p = await maClient.getPlayer(id);
            const muted = p.volume_muted ?? p.muted;
            // Not reported at all (null/undefined): nothing to check, assume it worked
            if (muted !== false) pending.delete(id);
          } catch {
            pending.delete(id);
          }
        })
      );
      if (pending.size > 0) await sleep(POLL_MS);
    }
    const out: MuteProblem[] = [];
    for (const id of pending) {
      this.unreportable.add(id);
      const room = rooms.find((r) => r.playerId === id)!;
      out.push({ name: room.name, reason: 'MA still shows it unmuted (may just be slow to update)', hard: false });
    }
    return out;
  }

  private report(newProblems: MuteProblem[]): void {
    let changed = false;
    for (const p of newProblems) {
      const existing = this.problems.get(p.name);
      if (!existing || existing.reason !== p.reason || existing.hard !== p.hard) {
        this.problems.set(p.name, p);
        changed = true;
      }
    }
    if (changed) this.onProblems(Array.from(this.problems.values()));
  }
}
