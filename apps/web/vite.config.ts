import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Set by `tauri dev` when running on a phone or simulator.
const tauriDevHost = process.env.TAURI_DEV_HOST

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Keep Tauri's Rust output visible in the terminal.
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: tauriDevHost || false,
    hmr: tauriDevHost ? { protocol: 'ws', host: tauriDevHost, port: 5174 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
})
