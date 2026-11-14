import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
export default defineConfig({
  cacheDir: resolve(import.meta.dirname, '../../../.local/cache/restored-input-preservation-vite'),
  plugins: [{ name: 'restored-input-source-binding', enforce: 'pre', load(id) {
    const path = id.split('?')[0]!, output = process.env.AGENTMUX_RECEIPT_SOURCE_LOADS
    if (output && path.includes('/packages/core/src/') && path.endsWith('.ts')) appendFileSync(output,
      JSON.stringify({ path: resolve(path), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }) + '\n', { mode: 0o600 })
    return null
  } }],
  test: { include: ['packages/core/test/restored-input-preservation.test.ts','packages/core/test/queue-restoration-publication.test.ts', 'packages/core/test/agent-global-message-queue.test.ts'],
    maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 20_000 }
})
