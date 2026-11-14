import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
export default defineConfig({
  cacheDir: resolve(import.meta.dirname, '../../../.local/cache/prompt-receipt-preservation-vite'),
  plugins: [{ name: 'prompt-receipt-source-binding', enforce: 'pre', transform(source, id) {
    const path = id.split('?')[0]!, output = process.env.AGENTMUX_RECEIPT_SOURCE_LOADS
    let code = source
    const candidate = process.env.AGENTMUX_RECEIPT_MUTANT ? JSON.parse(process.env.AGENTMUX_RECEIPT_MUTANT) : undefined
    if (candidate && resolve(path) === candidate.path) {
      if (createHash('sha256').update(readFileSync(path)).digest('hex') !== candidate.diskSHA256) throw Error('The original input owner changed under its mutation')
      code = readFileSync(candidate.file, 'utf8')
    }
    if (output && path.includes('/packages/core/src/') && path.endsWith('.ts')) appendFileSync(output,
      JSON.stringify({ path: resolve(path), sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), compiledSourceSHA256: createHash('sha256').update(code).digest('hex'), mutation: code === source ? null : candidate?.id }) + '\n', { mode: 0o600 })
    return code === source ? undefined : { code, map: null }
  } }],
  test: { include: ['packages/core/test/prompt-receipt-preservation.test.ts', 'packages/core/test/immediate-prompt.test.ts',
    'packages/core/test/current-terminal-prompt.test.ts', 'packages/core/test/native-prompt-authority-store.test.ts',
    'packages/core/test/agent-session-store-cas.test.ts', 'packages/core/test/agent-prompt-not-applied.test.ts'], passWithNoTests: false,
    maxWorkers: 1, fileParallelism: false, testTimeout: 20_000, hookTimeout: 20_000 }
})
