import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { groupSyncPlugin } from './vite-groupsync-plugin'

// https://vite.dev/config/
export default defineConfig({
  // Relative asset URLs, so the built app works under any path (Home Assistant ingress serves it under
  // /api/hassio_ingress/<token>/)
  base: './',
  plugins: [react(), tailwindcss(), basicSsl(), groupSyncPlugin()],
  server: {
    host: true,   // Allow mobile access on local network
    port: 5173,
    // GroupSync saves the MA token/address to .env.local at runtime; Vite would otherwise restart the
    // dev server (dropping every connection) whenever that file changes.
    watch: { ignored: ['**/.env.local'] },
    // HTTPS enabled by basicSsl plugin for microphone access on mobile
  },
})
