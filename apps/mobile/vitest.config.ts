import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['browser', 'module', 'import'], dedupe: ['react', 'react-dom'] },
  test: { setupFiles: ['test/device-locks.ts'], environment: 'happy-dom', environmentOptions: { happyDOM: { width: 390, height: 844 } }, include: ['test/**/*.test.{ts,tsx}'], restoreMocks: true }
})
