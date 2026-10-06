import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

// Strict Source mutants intentionally run the production TS reader and Host.
// The compiled CLI stays a real separate consumer; this config does not label
// that unchanged compiled artifact as mutant Source. Every actual Vite read is pinned.
export default defineConfig({
  plugins: [{ name: 'history-query-source-binding', enforce: 'pre', load(id) {
    const output = process.env.AGENTMUX_HISTORY_SOURCE_LOADS, path = id.split('?')[0]!
    if (output && path.includes('/packages/core/src/') && path.endsWith('.ts')) {
      appendFileSync(output, JSON.stringify({ path: resolve(path), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }) + '\n')
    }
    return null
  } }],
  test: { include: ['packages/core/test/session-history-query.test.ts'], setupFiles: ['./vitest.setup.ts'],
    testTimeout: 20000, hookTimeout: 20000, maxWorkers: 1, fileParallelism: false }
})
