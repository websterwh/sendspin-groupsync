/**
 * Calibration types for audio offset detection
 */

export type CalibrationPhase =
  | 'idle'
  | 'connecting'
  | 'selecting'
  | 'instructions'
  | 'listening'
  | 'calculating'
  | 'results';

export interface ClickDetection {
  timestamp: number;      // When click was detected (ms)
  frequency: number;      // Detected frequency (Hz)
  confidence: number;     // Detection confidence (0-1)
  sampleOffset: number;   // Sample offset from expected
}

/** The MA setting that shifts a player's timing (see sync-push/delaySettings.ts) */
export interface DelaySetting {
  label: string;
  /** Player whose config holds the setting (can be a protocol player under the device) */
  configPlayerId: string;
  key: string;
  current: number;
  min: number;
  max: number;
  /** True if raising the value makes the player play earlier */
  higherIsEarlier: boolean;
  /** Whether the direction above is documented (true) or assumed (false) */
  directionVerified: boolean;
}

export interface CalibrationResult {
  playerId: string;
  playerName: string;
  /** Suggested sync delay to enter for this player (ms, editable by the user) */
  offsetMs: number;
  /** How much later (+) or earlier (-) this room's sound arrives than the reference room, ms */
  arrivalMs?: number;
  /** sync_adjust currently set in Music Assistant, if it could be read */
  currentSyncAdjustMs?: number | null;
  /** Spread of the individual click measurements, ms */
  spreadMs?: number;
  isReference?: boolean;
  /** The MA setting that shifts this player, if one was found (offsetMs is then its suggested new value) */
  setting?: DelaySetting | null;
  /** The range of the setting stopped the suggested value short of what is needed */
  clamped?: boolean;
  /** Quality problems with this measurement (few clicks, unsteady, possibly two speakers audible, ...) */
  warnings?: string[];
  confidence: number;
  detectedClicks: number;
  totalClicks: number;
}

export interface CalibrationState {
  phase: CalibrationPhase;
  currentPlayer: string | null;
  detectedClicks: ClickDetection[];
  results: Map<string, CalibrationResult>;
  error: string | null;
}

export interface CalibrationConfig {
  clickIntervalMs: number;    // Time between clicks (default: 1000ms)
  totalClicks: number;        // Clicks in the track (default: 300, i.e. 5 minutes)
  frequencies: number[];      // Click frequencies (default: [1000, 2000, 4000, 8000])
  sampleRate: number;         // Audio sample rate (default: 48000)
}

export const DEFAULT_CALIBRATION_CONFIG: CalibrationConfig = {
  clickIntervalMs: 1000,
  totalClicks: 300,
  // Frequencies optimized for smartphone mic sensitivity (sweet spots: 500, 1k, 2k, 3k Hz)
  frequencies: [500, 1000, 2000, 3000],
  sampleRate: 48000,
};
