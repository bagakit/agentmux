import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './mote-discussion-threads.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const variants: Record<string, [string, string, string]> = {
  'search-disconnected': ['packages/client-ui/src/components/MoteConversationThreads.tsx', '(!search || summary.search.includes(search))', 'true'],
  'report-filter-disconnected': ['packages/client-ui/src/components/MoteConversationThreads.tsx', "filter === 'all' || filter === 'question' && summary.question ||", 'true ||'],
  'inline-wrong-host': ['packages/client-ui/src/components/MoteConversationThreads.tsx', 'event.sources.some(source => sameActor(source.main, actor))', 'event.sources.some(source => source.main.agentSessionId === actor.agentSessionId)'],
  'inline-disconnected': ['packages/client-ui/src/components/MoteConversationThreads.tsx', 'current && page && work ? <InlineWorkThreads', 'false ? <InlineWorkThreads'],
  'dispatch-count-is-worker-count': ['packages/client-ui/src/components/MoteConversationThreads.tsx', 'const workerCount = new Set(event.sources.map(source => JSON.stringify([source.origin.hostId, source.origin.recipientSessionId]))).size', 'const workerCount = event.sources.length'],
  'search-ignores-foreground': ['packages/client-ui/src/components/MoteConversationThreads.tsx', 'discovering={discovering && viewport.visible}', 'discovering={discovering}']
}
const mutation = process.env.AGENTMUX_THREAD_DISCOVERY_MUTATION
if (mutation && !variants[mutation]) throw Error('Unknown thread discovery mutation')
export default defineConfig({ ...base,
  plugins: [...base.plugins ?? [], { name: 'loaded-thread-discovery-counterexample', enforce: 'pre', transform(original, id) {
    if (!mutation) return
    const [file, before, after] = variants[mutation]!
    if (relative(root, id.split('?')[0]!) !== file) return
    if (original.split(before).length !== 2) throw Error('Expected one exact source anchor: ' + mutation)
    const changed = original.replace(before, after), trace = process.env.AGENTMUX_THREAD_DISCOVERY_TRACE
    if (!trace) throw Error('Mutation trace required')
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    appendFileSync(trace, JSON.stringify({ mutation, file, original: hash(original), changed: hash(changed) }) + '\n')
    return { code: changed, map: null }
  } }],
  test: { ...base.test, include: ['apps/desktop/test/mote-thread-discovery.test.tsx'], passWithNoTests: false, testTimeout: 15000 }
})
