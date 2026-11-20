import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// Owner-backed fixtures must consume the same Demand source as the current Host.
const demand = resolve(import.meta.dirname, '../../packages/demand/src')

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['browser', 'module', 'import'], dedupe: ['react', 'react-dom'], alias: [
    { find: /^@agentmux\/demand$/u, replacement: resolve(demand, 'index.ts') },
    { find: /^@agentmux\/demand\/goals$/u, replacement: resolve(demand, 'goals.ts') },
  ] },
  test: { setupFiles: ['test/device-locks.ts'], environment: 'happy-dom', environmentOptions: { happyDOM: { width: 390, height: 844 } }, include: ['test/**/*.test.{ts,tsx}'], restoreMocks: true }
})
