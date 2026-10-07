import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../../../..')
const mutations: Record<string, { path: string; from: string; to: string }> = {
  'drop-codex-metrics': { path: 'packages/core/src/providers/codex-saved-history.ts', from: '    ...metrics(record, payload, nativeSessionId),\n', to: '' },
  'wrong-codex-scope': { path: 'packages/core/src/providers/codex-saved-history.ts', from: 'const usage = object(payload.turn_token_usage)', to: 'const usage = object(payload.thread_token_usage)' },
  'borrow-foreign-usage': { path: 'packages/core/src/providers/codex-saved-history.ts', from: '  if (!sameSource) return { metricsDiagnostic:', to: '  if (false) return { metricsDiagnostic:' },
  'drop-normalized-metrics': { path: 'packages/core/src/session-history.ts', from: '      ...normalizeSessionHistoryMetrics(item),\n', to: '' },
  'claude-response-as-turn': { path: 'packages/core/src/providers/claude-native-history.ts', from: "metrics: { scope: 'response', usage: {", to: "metrics: { scope: 'turn', usage: {" },
  'hook-response-as-turn': { path: 'packages/core/src/agent-usage-transcript.ts', from: "      scope: 'response',\n", to: "      scope: 'turn',\n" }
}
const mutation = process.env.AGENTMUX_TURN_SUMMARY_MUTATION
if (mutation && !mutations[mutation]) throw new Error('Unknown native turn summary mutation: ' + mutation)

export default defineConfig({ ...original, root,
  plugins: [...(original.plugins ?? []), { name: 'native-turn-summary-loaded-source', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('packages/core/src/') || !path.endsWith('.ts')) return
    const before = code, target = mutation ? mutations[mutation]! : undefined
    if (target?.path === path) {
      const count = code.split(target.from).length - 1
      if (count !== (mutation === 'hook-response-as-turn' ? 2 : 1)) throw new Error('Mutation anchor is no longer exact: ' + mutation)
      code = code.replaceAll(target.from, target.to)
    }
    const output = process.env.AGENTMUX_TURN_SUMMARY_LOADED
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    if (output) appendFileSync(output, JSON.stringify({ path, originalSHA256: hash(before), sha256: hash(code),
      bytes: Buffer.byteLength(code), ...(before !== code ? { mutation } : {}) }) + '\n')
    if (before !== code) return { code, map: null }
  } }],
  test: { ...original.test, globalSetup: [], include: ['packages/core/test/native-turn-summary.test.ts',
    'packages/core/test/agent-usage-transcript.test.ts', 'packages/core/test/agent-usage-capability.test.ts'],
    passWithNoTests: false, fileParallelism: false }
})
