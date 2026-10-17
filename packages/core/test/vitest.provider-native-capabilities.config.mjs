import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
export const scopes = {
  input: ['packages/core/test/a2a-idle-input.test.ts', 'packages/core/test/codex-idle-queue.test.ts',
    'packages/core/test/codex-durable-queue.test.ts', 'packages/core/test/native-process-executable.test.ts'],
  history: ['packages/core/test/provider-executor-history.test.ts', 'apps/desktop/test/remote-executor-lifecycle.test.ts'],
  join: ['packages/core/test/codex-durable-queue-native.test.ts'],
}
export const mutations = {
  'require-private-actor': ['input', 'packages/core/src/prompt-submission.ts',
    'rejoiningFrozenPlan || current.hostId', 'rejoiningFrozenPlan || !current.nativeActor || current.hostId'],
  'skip-source-recheck': ['input', 'packages/core/src/prompt-submission.ts',
    'await prepared.assertCurrent()\n          dispatchAttempted', 'void 0\n          dispatchAttempted'],
  'unsent-is-unknown': ['input', 'packages/core/src/prompt-submission.ts',
    "outcome: dispatchAttempted ? 'unknown' as const : 'not-applied' as const", "outcome: 'unknown' as const"],
  'do-not-await-cleanup': ['input', 'packages/core/src/prompt-submission.ts',
    'await prepared.dispose()', 'void prepared.dispose().catch(() => {})'],
  'queue-helper-borrows-another-store': ['input', 'packages/core/src/providers/codex-native-queue.ts',
    '!sameFile(helperStores.queue, storage.queue)', 'false'],
  'queue-receipt-loses-original-correlation': ['input', 'packages/core/src/providers/codex-native-queue.ts',
    'item.clientUserMessageId !== frozen.clientCorrelation', 'false'],
  'queue-file-open-blocks': ['input', 'packages/core/src/providers/codex-native-queue.ts',
    ' | constants.O_NONBLOCK', ''],
  'executable-receipt-loses-owner': ['input', 'packages/core/src/agent-native-process.ts',
    'receipt.uid !== process.getuid?.()', 'false'],
  'history-requires-unrelated-template': ['history', 'packages/core/src/client.ts',
    'if (!targetOwned && (explicit || historyAgentSessionId !== undefined)) return input', 'if (!targetOwned && explicit) return input'],
  'history-ignores-original-owner': ['history', 'packages/core/src/client.ts',
    'if (!targetOwned && (explicit || historyAgentSessionId !== undefined)) return input', 'if (explicit || historyAgentSessionId !== undefined) return input'],
}

export default defineConfig({ root, cacheDir: resolve(root, '.tmp/provider-native-capabilities/vite-cache'),
  plugins: [{ name: 'provider-capabilities-source', enforce: 'pre', resolveId(id) {
    const match = id.match(/^@agentmux\/([^/]+)(.*)$/u)
    if (!match) return
    const directory = resolve(root, 'packages', match[1])
    const value = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')).exports?.[match[2] ? '.' + match[2] : '.']
    const entry = typeof value === 'string' ? value : value?.import
    if (typeof entry === 'string' && entry.startsWith('./dist/')) return resolve(directory,
      entry.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
  }, transform(code, id) {
    const file = relative(root, id.split('?')[0])
    if (!/^(?:packages\/[^/]+|apps\/desktop)\/src\//u.test(file)) return
    const mutation = process.env.AGENTMUX_PROVIDER_CAPABILITY_MUTATION
    if (mutation && !mutations[mutation]) throw Error('Unknown Provider capability mutation')
    const change = mutation && mutations[mutation], original = code
    if (change && file === change[1]) {
      if (code.split(change[2]).length !== 2) throw Error('Non-unique mutation anchor: ' + mutation)
      code = code.replace(change[2], change[3])
    }
    const hash = value => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_PROVIDER_CAPABILITY_LOADED) appendFileSync(process.env.AGENTMUX_PROVIDER_CAPABILITY_LOADED,
      JSON.stringify({ file, originalSHA256: hash(original), sha256: hash(code), ...(original === code ? {} : { mutation }) }) + '\n')
    if (code !== original) return { code, map: null }
  } }], test: { include: Object.values(scopes).flat(), globalSetup: [], setupFiles: [], maxWorkers: 1,
    fileParallelism: false, passWithNoTests: false, testTimeout: 30_000 } })
