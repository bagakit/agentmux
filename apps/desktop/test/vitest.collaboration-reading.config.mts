import { defineConfig } from 'vitest/config'
import base from './vitest.performance-reading.config.mts'
import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'
import { createHash } from 'node:crypto'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const mutations: Record<string, { file: string; from: string; to: string }> = {
  'delta-high-water': { file: 'use-collaboration-reading.ts', from: '(state.current[key]?.updates?.after ?? 0) < (wanted.get(key) ?? 0)', to: 'false' },
  'independent-readers': { file: 'use-collaboration-reading.ts', from: 'await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker))',
    to: "while (current() && queue.length) { const batch = queue.splice(0, 4); await Promise.all(batch.map(key => run(key, 'refresh'))) }" },
  'hidden-generation': { file: 'use-collaboration-reading.ts', from: 'const current = () => token === generation.current', to: 'const current = () => true' },
  'exact-event-source': { file: 'use-collaboration-reading.ts', from: "if (page.hostId !== subject.hostId || page.participantSessionId !== subject.agentSessionId) throw new Error('The original message Host or participant did not match.')", to: '' },
  'initial-observation': { file: 'use-collaboration-reading.ts', from: "'Automatic updates are unconfirmed. Refresh the original source.'", to: 'null' },
  'source-watermark-reset': { file: 'use-collaboration-reading.ts', from: 'wanted.delete(key); pulseThrough.delete(subject.hostId); setPulses([])', to: '' },
  'initial-watermark-reset': { file: 'use-collaboration-reading.ts', from: 'latest && previous.incarnation !== null && previous.incarnation !== page.incarnation', to: 'latest && previous.incarnation !== page.incarnation' },
  'catchup-is-live': { file: 'use-collaboration-reading.ts', from: 'event.live && event.sequence >', to: 'event.sequence >' },
  'journal-evidence': { file: 'agent-collaboration.ts', from: 'JSON.stringify([hostId, reading.incarnation, ref.messageId])', to: 'JSON.stringify([hostId, ref.messageId])' },
  'participant-event-dedup': { file: 'agent-collaboration.ts', from: 'JSON.stringify([reading.incarnation, event.sequence])', to: 'JSON.stringify([reading.subject, reading.incarnation, event.sequence])' },
  'foreign-runtime-route': { file: 'agent-collaboration.ts', from: 'subject: null, sessionId: creator.agentSessionId', to: 'subject: { hostId, agentSessionId: creator.agentSessionId }, sessionId: creator.agentSessionId' }
}
const selected = process.env.AGENTMUX_COLLABORATION_READING_MUTANT
if (selected && !mutations[selected]) throw new Error('Unknown collaboration reading mutant: ' + selected)
let loaded = false
export default defineConfig({ ...base, cacheDir: '.cache/collaboration-reading', plugins: [...base.plugins!, {
  name: 'collaboration-reading-source-proof', enforce: 'pre', transform(source, id) {
    const file = relative(process.cwd(), id.split('?')[0]!)
    if (!file.startsWith('apps/desktop/src/') && !file.startsWith('packages/')) return
    const mutation = selected ? mutations[selected]! : undefined
    const applied = mutation && file.endsWith('/lib/' + mutation.file)
    let effective = source
    if (applied) {
      if (source.split(mutation.from).length !== 2) throw new Error('Collaboration reading mutant anchor must be unique: ' + selected)
      effective = source.replace(mutation.from, mutation.to); loaded = true
    }
    const log = process.env.AGENTMUX_COLLABORATION_READING_LOADED
    if (log) appendFileSync(log, JSON.stringify({ path: file, originalSHA256: hash(source), effectiveSHA256: hash(effective), mutant: applied ? selected : null }) + '\n')
    return effective === source ? undefined : { code: effective, map: null }
  }, buildEnd() { if (selected && !loaded) throw new Error('Collaboration reading mutant source was not loaded: ' + selected) }
}], test: { ...base.test, environment: 'happy-dom', include: ['apps/desktop/test/collaboration-reading.test.tsx'] } })
