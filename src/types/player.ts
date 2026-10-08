/**
 * Player types for Music Assistant Sendspin players
 */

export interface Player {
  player_id: string;
  name: string;
  type: string;
  available: boolean;
  powered: boolean;
  playback_state?: string;
  output_protocols?: Array<{ output_protocol_id: string; protocol_domain?: string; is_native?: boolean; available?: boolean }>;
  state?: string;
  volume_level: number;
  muted?: boolean;
  volume_muted?: boolean;
  group_childs?: string[];
  group_members?: string[];
  static_group_members?: string[];
  synced_to?: string | null;
  active_group?: string | null;
  can_sync_with?: string[];
}

export interface PlayerGroup {
  group_id: string;
  name: string;
  members: string[];
  leader: string;
}

export interface PlayerState {
  players: Player[];
  selectedPlayers: string[];
  loading: boolean;
  error: string | null;
}
