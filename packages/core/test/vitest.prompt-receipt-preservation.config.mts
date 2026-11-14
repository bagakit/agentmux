import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
export default defineConfig({
  cacheDir: resolve(import.meta.dirname, '../../../.local/cache/prompt-receipt-preservation-vite'),
  plugins: [{ name: 'prompt-receipt-source-binding', enforce: 'pre', load(id) {
    const path = id.split('?')[0]!, output = process.env.AGENTMUX_RECEIPT_SOURCE_LOADS
    if (output && path.includes('/packages/core/src/') && path.endsWith('.ts')) appendFileSync(output,
      JSON.stringify({ path: resolve(path), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }) + '\n')
    return null
  } }],
  test: { include: ['packages/core/test/prompt-receipt-preservation.test.ts', 'packages/core/test/immediate-prompt.test.ts',
    'packages/core/test/current-terminal-prompt.test.ts', 'packages/core/test/native-prompt-authority-store.test.ts',
    'packages/core/test/agent-session-store-cas.test.ts', 'packages/core/test/agent-prompt-not-applied.test.ts'], passWithNoTests: false,
    maxWorkers: 1, fileParallelism: false, testTimeout: 20_000, hookTimeout: 20_000 }
})
