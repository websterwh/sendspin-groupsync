import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { groupSyncPlugin } from './vite-groupsync-plugin'

// https://vite.dev/config/
export default defineConfig({
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
