import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'
const root = resolve(import.meta.dirname, '../../..')
const changes: Record<string, [string, string, string]> = {
  'invert-tail-clock': ['conversation-timeline.ts', 'at > bt', 'at < bt'],
  'accept-future-captured-cut': ['conversation-reader.ts', ' || cut.sequence > current.stream.sequence', ''],
  'advance-before-complete-unit': ['conversation-reader.ts', 'frontier: index < units.length ? state.checkpoint! : batch.end!', 'frontier: batch.end!'],
  'trust-route-cursor-fields': ['conversation-reader.ts', 'if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error()', 'if (actual.length !== expected.length) throw Error()'],
  'trust-unrelated-relation': ['conversation-changes.ts', 'if (!local && !byId.has(conversationRecordId(to)) || local &&', 'if (local &&'],
  'trust-coalesce-claim': ['conversation-changes.ts', '!same(e.coalesces, expectedCoalesces.length ? expectedCoalesces : undefined)', 'false'],
  'trust-event-anchor': ['conversation-changes.ts', "if (records.some(record => record.id !== id && anchors.get(record.id) !== id))", 'if (false)'],
  'trust-answer-claim': ['conversation-changes.ts', "value.questionId === question.questionId", 'true'],
  'trust-observation-claim': ['conversation-changes.ts', "if (!observer && !observed || observer && !same(observer.original.item.conversation?.observes, target)) return bad()", 'if (false) return bad()'],
  'trust-invocation-claim': ['conversation-changes.ts', 'if (!local.length || local.some(', 'if (false && local.some('],
  'trust-event-role': ['conversation-changes.ts', 'e.role !== conversationRecordRole(primary) || ', ''],
  'cross-session-watch': ['client-event-publisher.ts', 'this.timelineListeners.get(event.agentSessionId) ?? []', 'new Map([...this.timelineListeners.values()].flatMap(listeners => [...listeners]))'],
  'forge-source-host-receipt': ['client.ts', 'return { ...await this.store.loadTimeline(agentSessionId), sourceHostId: descriptor.hostId }', "return { ...await this.store.loadTimeline(agentSessionId), sourceHostId: 'local' }"],
  'drop-source-retry-position': ['conversation-reader.ts', "coverage[coverage.findIndex(c => c.source.kind === 'native')] = failure;", "failure.gaps = failure.gaps.map(({ continuation: _missing, ...gap }) => gap); coverage[coverage.findIndex(c => c.source.kind === 'native')] = failure;"]
}
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.cache/conversation-unified', process.env.AGENTMUX_UNIFIED_MUTATION ?? 'baseline'),
  plugins: [{ name: 'unified-conversation-actual-loaded', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!); if (!path.startsWith('packages/core/src/') || !/\.ts$/u.test(path)) return
    const before = code, mutation = process.env.AGENTMUX_UNIFIED_MUTATION
    if (mutation) {
      const change = changes[mutation]; if (!change) throw new Error('Unknown unified conversation mutation: ' + mutation)
      if (path === 'packages/core/src/' + change[0]) {
        if (code.split(change[1]).length !== 2) throw new Error('Missing unique unified mutation anchor: ' + mutation)
        code = code.replace(change[1], change[2])
      }
    }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_UNIFIED_LOADED) appendFileSync(process.env.AGENTMUX_UNIFIED_LOADED, JSON.stringify({ path, originalSHA256: sha(before), sha256: sha(code), ...(before !== code ? { mutation } : {}) }) + '\n')
    if (before !== code) return { code, map: null }
  } }], test: { ...original.test, globalSetup: [], include: process.env.AGENTMUX_UNIFIED_ADJACENT === '1' ? [
    'packages/core/test/conversation-timeline.test.ts', 'packages/core/test/client-event-publisher.test.ts',
    'packages/connectors/test/room-binding.test.ts', 'packages/connectors/test/durable-publication.test.ts', 'packages/connectors/test/publication-worker-consumer.test.ts'
  ] : ['packages/core/test/conversation-unified-public.test.ts',
    ...(process.env.AGENTMUX_UNIFIED_COMPILED === '1' ? ['packages/core/test/conversation-catch-up.test.ts', 'packages/core/test/conversation-facade.test.ts', 'packages/core/test/conversation-resource-anchor.test.ts'] : [])],
    passWithNoTests: false, fileParallelism: false } })
