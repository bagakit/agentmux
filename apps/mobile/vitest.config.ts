import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['browser', 'module', 'import'], dedupe: ['react', 'react-dom'] },
  test: { setupFiles: ['test/device-locks.ts'], environment: 'happy-dom', include: ['test/**/*.test.{ts,tsx}'], restoreMocks: true }
})
