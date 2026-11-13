import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { prepareHookTransactionTargets } from './fixtures/hook-transaction/source-targets.mjs'
await prepareHookTransactionTargets()
// Reuse the existing manifest-driven current-source aliases and React owner.
const base = (await import('../../../apps/desktop/test/vitest.mote-context.config.mts')).default
const root = resolve(import.meta.dirname, '../../..')
const inverse = process.env.AGENTMUX_TEST_HOOK_TRANSACTION_INVERSE
  ? JSON.parse(readFileSync(process.env.AGENTMUX_TEST_HOOK_TRANSACTION_INVERSE, 'utf8')) as { name: string; file: string; before: string; after: string }
  : undefined
export default defineConfig({ ...base, cacheDir: resolve(root, '.cache/hook-transaction'),
  plugins: [{ name: 'hook-transaction-source-proof', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    let loaded = code
    if (inverse?.file === path) {
      if (code.split(inverse.before).length !== 2) throw new Error('A bearing source inverse must match exactly once: ' + inverse.name)
      loaded = code.replace(inverse.before, inverse.after)
    }
    const report = process.env.AGENTMUX_TEST_HOOK_TRANSACTION_LOADED
    if (report && (path.startsWith('packages/') || path.startsWith('apps/'))) appendFileSync(report, JSON.stringify({ path,
      originalSHA256: createHash('sha256').update(code).digest('hex'), loadedSHA256: createHash('sha256').update(loaded).digest('hex'),
      ...(loaded === code ? {} : { inverse: inverse?.name }) }) + '\n')
    return loaded === code ? undefined : { code: loaded, map: null }
  } }],
  test: { ...base.test, globalSetup: [], passWithNoTests: false, fileParallelism: false, maxWorkers: 1,
    include: ['packages/core/test/hook-transaction.test.ts', 'packages/core/test/hook-transaction-store.test.ts',
      'packages/core/test/agent-session-store-cas.test.ts', 'packages/core/test/native-prompt-authority-store.test.ts',
      'packages/core/test/hook-postcommit-observation.test.ts'],
    testNamePattern: process.env.AGENTMUX_TEST_HOOK_TRANSACTION_PATTERN || undefined,
    testTimeout: 30000, hookTimeout: 30000 }
})
