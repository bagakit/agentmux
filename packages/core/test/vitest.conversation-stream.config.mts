import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, [string, string, string]> = {
  'rehash-original': ['conversation-stream.ts', 'const records = mergeSources(native, captured), byId',
    'const records = mergeSources(native, captured).map(record => ({ ...record, revision: conversationRevision(record.original.item) })), byId'],
  'forget-relation': ['conversation-stream.ts', 'const target = provenance?.sameEvent ?? adopted.targets.get(record.id)', 'const target = undefined'],
  'reader-source-detour': ['conversation-reader.ts',
    'const timeline = projectConversationStream({ agentSessionId: ref.agentSessionId, reference: ref, records: rows,\n    scope: accepted, coverage, inputAdoption, ...(source ? { nativeSource: source } : {}) })',
    `const timeline = sourceAdapterProbe({ agentSessionId: ref.agentSessionId, executionHostId: ref.hostId,
      ...(source ? { historyPage: { agentSessionId: ref.agentSessionId, source, nextCursor: null,
        items: rows.flatMap(record => record.original.kind === 'native' ? [record.original.item] : []) } } : {}),
      timeline: { agentSessionId: ref.agentSessionId, revision: 0,
        items: rows.flatMap(record => record.original.kind === 'captured' ? [record.original.item] : []) },
      sourceOrders: new Map(rows.map(record => [record.id, record.order])), coverage, inputAdoption })`]

}
export default defineConfig({ ...original, root, cacheDir: '.cache/conversation-stream', plugins: [{
  name: 'conversation-stream-loaded-source', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('packages/core/src/') || !path.endsWith('.ts')) return
    const mutation = process.env.AGENTMUX_STREAM_MUTATION, change = mutation ? mutations[mutation] : undefined
    if (mutation && !change) throw Error('Unknown stream mutation')
    let code = source
    if (change && path === 'packages/core/src/' + change[0]) {
      if (code.split(change[1]).length !== 2) throw Error('Missing unique stream mutation anchor')
      code = code.replace(change[1], change[2])
      if (mutation === 'reader-source-detour') code = "import { projectConversationTimeline as sourceAdapterProbe } from './conversation-timeline.js'\n" + code
    }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_STREAM_LOADED) appendFileSync(process.env.AGENTMUX_STREAM_LOADED,
      JSON.stringify({ path, originalSHA256: sha(source), sha256: sha(code), ...(code === source ? {} : { mutation }) }) + '\n')
    if (code !== source) return { code, map: null }
  }
}], test: { ...original.test, globalSetup: [], setupFiles: [], passWithNoTests: false, fileParallelism: false, maxWorkers: 1,
  include: ['packages/core/test/conversation-stream.test.ts', 'packages/core/test/conversation-timeline.test.ts',
    'packages/core/test/conversation-summary.test.ts', 'packages/core/test/session-inputs.test.ts'], testTimeout: 30000 }
})
