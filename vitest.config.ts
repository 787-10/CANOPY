import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Standalone config (not vite.config.ts) so the test runner skips the Cesium
// static-copy plugin — none of the unit-tested modules (store, socket hooks,
// mission-state hook) import Cesium, and copying its assets on every run would
// be dead weight.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
})
