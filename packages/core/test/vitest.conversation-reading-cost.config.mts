import original from './vitest.conversation-resilience.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...original, cacheDir: '.cache/conversation-reading-cost', resolve: { alias: { '@agentmux/core/conversation': resolve(root, 'packages/core/src/conversation.ts') } }, plugins: [...original.plugins ?? [], {
  name: 'actual-conversation-work-counters', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!['packages/core/src/conversation-reader.ts','packages/core/src/conversation-timeline.ts'].includes(path)) return
    let code = source
    const counter = (field: string) => `const probe = Reflect.get(globalThis, '__amuxConversationCost'); if (probe) probe.${field}++;`
    if (path.endsWith('conversation-reader.ts')) {
      const target = /function historyNavigation\([^\n]+\) \{/
      if ((source.match(new RegExp(target.source,'g')) ?? []).length !== 1) throw Error('Missing unique actual navigation owner')
      code = source.replace(target, head => head + '\n  ' + counter('navigationCalls'))
    }
    if (path.endsWith('conversation-timeline.ts')) {
      const target = 'export function conversationRevision(value: unknown): string {'
      if (source.split(target).length !== 2) throw Error('Missing unique actual revision owner')
      code = source.replace(target, target + '\n  ' + counter('revisionCalls'))
    }
    const mutation = process.env.AGENTMUX_READING_COST_MUTATION
    const edits: Record<string, [string,string,string]> = {
      'repeat-navigation': ['packages/core/src/conversation-reader.ts', 'snapshot.navigation ??= historyNavigation(snapshot.rows, snapshot.history)', 'historyNavigation(snapshot.rows, snapshot.history)'],
      'restore-unused-locators': ['packages/core/src/conversation-reader.ts', 'const batch: Batch = { ...loaded.batch, index: 0, offset: 0, digests: [] }', "const batch: Batch = { ...loaded.batch, records: loaded.rows.map(r => ({ id: r.id, reference: r.reference!, revision: r.revision, order: r.order, source: r.original.kind })), index: 0, offset: 0, digests: [] }"]
    }
    const selected = mutation === 'legacy-all' ? Object.values(edits) : mutation && edits[mutation] ? [edits[mutation]!] : []
    if (mutation && !selected.length) throw Error('Unknown work counter mutation')
    let changed = false
    for (const edit of selected) if (path === edit[0]) { if (code.split(edit[1]).length !== 2) throw Error('Missing unique work counter mutation'); code = code.replace(edit[1],edit[2]); changed = true }
    const sha = (value:string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_READING_COST_LOADED) appendFileSync(process.env.AGENTMUX_READING_COST_LOADED, JSON.stringify({ path, originalSHA256: sha(source), sha256: sha(code), counters: path.endsWith('conversation-reader.ts') || path.endsWith('conversation-timeline.ts'), mutation: changed ? mutation : null }) + '\n')
    return code === source ? undefined : code
  }
}], test: { ...original.test, include: ['packages/core/test/conversation-reading-cost.test.ts'], passWithNoTests: false, fileParallelism: false, testTimeout: 60000 } })
