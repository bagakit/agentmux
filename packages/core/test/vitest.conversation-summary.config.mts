import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original, { conversationSourceAliases } from '../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../..')
const changes: Record<string, [string, string, string]> = {
  'restore-summary-hashes': ['packages/conversation/src/conversation-stream.ts', 'return projectConversationGraph(input, event => event)', 'return projectConversationStream(input)'],
  'drop-graph-association': ['packages/conversation/src/conversation-stream.ts', 'const target = provenance?.sameEvent ?? adopted.targets.get(record.id)', 'const target = undefined'],
  'change-full-version-policy': ['packages/conversation/src/conversation-stream.ts', 'conversationRevision({ policy: 1, versions: group.map(record => [record.id, record.revision]), event })', 'conversationRevision({ policy: 2, versions: group.map(record => [record.id, record.revision]), event })']
}

export default defineConfig({ ...original, root, resolve: { alias: { ...original.resolve.alias, ...conversationSourceAliases } },
  cacheDir: resolve(root, '.cache/conversation-summary', process.env.AGENTMUX_SUMMARY_MUTATION ?? 'candidate'),
  plugins: [{ name: 'conversation-summary-loaded-source', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^packages\/(core|conversation)\/src\//u.test(path) || !/\.ts$/u.test(path)) return
    const before = code, mutation = process.env.AGENTMUX_SUMMARY_MUTATION
    if (mutation) {
      const change = changes[mutation]
      if (!change) throw Error('Unknown conversation summary mutation: ' + mutation)
      if (path === change[0]) {
        if (code.split(change[1]).length !== 2) throw Error('Missing unique conversation summary mutation anchor: ' + mutation)
        code = code.replace(change[1], change[2])
      }
    }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_SUMMARY_LOADED) appendFileSync(process.env.AGENTMUX_SUMMARY_LOADED,
      JSON.stringify({ path, originalSHA256: sha(before), sha256: sha(code), ...(code === before ? {} : { mutation }) }) + '\n')
    if (code !== before) return { code, map: null }
  } }],
  test: { ...original.test, globalSetup: [], setupFiles: [], include: ['packages/core/test/conversation-summary.test.ts'],
    passWithNoTests: false, fileParallelism: false }
})
