# GroupSync

## Live drift test (dev server only)

`npm run dev` has a second tool on the home screen: **Live drift test**. Pick two speakers, play your own music (Spotify Connect, anything), and it shows the gap between them while the music plays, with a chart of how it changes. It learns the room first (about 40 s: only speaker A plays, then only B, using mute) and matches the two speakers' volumes at the phone (restored when you stop unless you tick *Keep*), then updates about once a second. *Speed* sets how much recent audio counts (Fast reacts in a few seconds, Steady is smoother); *Clear* restarts the readings after you change a delay.

- It reports the *size* of the gap, not which speaker is ahead. The click test gives the direction, and the live screen shows the last click-test value for the pair so you can compare.
- It works best with busy music or speech. Put the phone between the speakers at about equal distance.
- It is not included in production builds or the Home Assistant app.

## Home Assistant app (add-on)

Run GroupSync inside Home Assistant and open it from the HA app's sidebar (no computer needed).

1. Copy the `groupsync/` folder of this repo into Home Assistant's `/addons/` folder (the `addons` Samba share, or the SSH add-on).
2. Settings → Apps → *Install app* (App store) → ⋮ → *Check for updates*. **GroupSync** appears under *Local apps*. Install it. (Older HA versions call these Add-ons.)
3. In its Configuration tab set `ma_url` (e.g. `192.168.1.9:8095`) and `ma_token` (a long-lived token from Music Assistant). Start it and turn on *Show in sidebar*.
4. Open Home Assistant over **HTTPS** (Nabu Casa, DuckDNS or your own certificate). Browsers, including the HA app, block the microphone on plain `http://`.

The token stays on the server; the page never sees it. Music Assistant fetches the click track from the add-on on port 5174.
After changing the code run `npm run build:addon`, copy `groupsync/` over again and rebuild the add-on.

## Quick start (how measurement works now)

1. `npm install && npm run dev` on a desktop; open the printed **https** Network URL on your phone (accept the self-signed cert once - needed for the mic).
2. Connect with MA's address (`192.168.x.x:8095`, plain HTTP is fine) and paste a long-lived token (tick *Save token in .env.local* to keep it on the desktop as `MA_TOKEN`; the dev server substitutes it, so it never reaches the browser and phones connect without typing it). The dev server proxies MA over `wss://` so the browser doesn't block it, and serves the click track over plain HTTP on port 5174 (allow 5173/5174 through the desktop firewall). No other setup.
3. Put the players you want in sync into **one sync group in Music Assistant**, select them here and start. Walk to each room and tap *Measure here*; return to the first room at the end (corrects clock drift).
4. Results are shown as a suggested per-player sync delay (MA's `sync_adjust`). Enter them in MA yourself, or tick *auto-push* (off by default).

Why one recording: every room is compared on the same track timeline inside a single recording, so the unknown delay between "play" and sound cancels out. Measuring speakers one at a time cannot give a sync offset.


A mobile web application for synchronizing multiple Sendspin players in multi-room audio setups.

## Overview

GroupSync solves the challenge of achieving sample-accurate audio synchronization across multiple Sendspin speakers. Users walk around their listening space holding their phone near each speaker, and the app uses the device microphone to detect audio offset. The calculated offset is then pushed to each player to achieve perfect synchronization.

## Features

- **Music Assistant Integration** - Connects via WebSocket to discover and control Sendspin players
- **Automatic Offset Detection** - Uses microphone to measure audio delay at each speaker
- **Cross-Correlation Algorithm** - Sub-millisecond accuracy offset calculation
- **Protocol Extension** - Pushes offset to players via new `client/sync_offset` message
- **Mobile-First Design** - Optimized for walking around with phone in hand

## How It Works

1. **Connect** - Enter your Music Assistant server URL
2. **Select Players** - Choose which Sendspin players to synchronize
3. **Calibrate** - Walk to each speaker, hold phone nearby while calibration track plays
4. **Apply** - Push calculated offsets to all players

### Calibration Process

GroupSync plays a specially designed click track through all selected speakers simultaneously:
- 20 seconds duration
- Clicks at 1-second intervals
- Rotating frequencies (1kHz, 2kHz, 4kHz, 8kHz) for reliable detection
- Cross-correlation algorithm calculates precise offset

## Technology Stack

| Component | Technology |
|-----------|------------|
| Framework | React 18 + TypeScript 5 |
| Build | Vite |
| Audio | Web Audio API |
| State | Zustand |
| UI | Tailwind CSS |

## Requirements

- Music Assistant server (v2.7+) with Sendspin player provider
- One or more Sendspin-compatible players
- Mobile device with microphone (iOS Safari or Android Chrome)
- HTTPS connection (required for microphone access)

## Supported Players

### Direct Support (protocol extension)
- **windowsSpin** - Windows desktop player
- **SpinDroid** - Android player

### Via PR (pending)
- **sendspin-js** - Web/Cast player
- **sendspin-cli** - Python CLI player

## Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/groupsync.git
cd groupsync

# Install dependencies
npm install

# Start development server (HTTPS required for microphone)
npm run dev

# Build for production
npm run build
```

## Usage

### Development

```bash
npm run dev
```

Opens at `https://localhost:5173` (HTTPS required for microphone access).

### Production

```bash
npm run build
npm run preview
```

Deploy the `dist/` folder to any static hosting service (GitHub Pages, Vercel, Netlify).

## Configuration

### Environment Variables

None required. Server URL is entered at runtime.

### Vite Config

HTTPS is enabled by default for development to allow microphone access:

```typescript
// vite.config.ts
export default defineConfig({
  server: {
    https: true,
    host: true, // Allow mobile access
  },
});
```

## Protocol Extension

GroupSync extends the Sendspin protocol with a new message type:

```typescript
interface SyncOffsetMessage {
  type: 'client/sync_offset';
  payload: {
    player_id: string;
    offset_ms: number;      // Positive = delay, negative = advance
    source: 'groupsync';
  };
}
```

Players receive this message and adjust their internal sync delay accordingly.

## Project Structure

```
groupsync/
├── src/
│   ├── main.tsx              # Entry point
│   ├── App.tsx               # Main component
│   ├── calibration/          # Audio detection & offset calculation
│   ├── ma-client/            # Music Assistant WebSocket client
│   ├── sync-push/            # Offset push mechanism
│   ├── store/                # Zustand state management
│   ├── components/           # React UI components
│   └── types/                # TypeScript type definitions
├── public/
│   └── calibration-track.wav # Pre-generated click track
└── docs/
    ├── ARCHITECTURE.md       # Technical architecture
    └── PROTOCOL.md           # Protocol extension details
```

## Related Projects

- [Music Assistant](https://github.com/music-assistant) - Home music server
- [Sendspin Protocol](https://www.sendspin-audio.com/spec/) - Synchronized audio streaming
- [windowsSpin](https://github.com/yourusername/windowsSpin) - Windows Sendspin player
- [SpinDroid](https://github.com/yourusername/SpinDroid) - Android Sendspin player

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Acknowledgments

- Music Assistant team for the excellent home audio server
- Sendspin protocol designers for the synchronized audio specification
