import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Keep Rust compiler output visible when running under `tauri dev`
  clearScreen: false,
  server: {
    // Rust sources are rebuilt by Tauri, not Vite
    watch: { ignored: ['**/src-tauri/**'] },
  },
  // Tauri's WebView2 is evergreen Chromium; the browser build targets the same baseline
  envPrefix: ['VITE_', 'TAURI_ENV_'],
})
