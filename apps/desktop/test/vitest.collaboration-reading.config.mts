import { defineConfig } from 'vitest/config'
import base from './vitest.performance-reading.config.mts'
import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'
import { createHash } from 'node:crypto'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export const collaborationReadingMutations: Record<string, { file: string; from: string; to: string; assertion: string }> = {
  'delta-high-water': { file: 'use-collaboration-reading.ts', from: '(state.current[key]?.updates?.after ?? 0) < (wanted.get(key) ?? 0)', to: 'false', assertion: 'drains the frozen forward window before opening a new cut for a later observed event' },
  'independent-readers': { file: 'use-collaboration-reading.ts', from: 'await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker))',
    to: "while (current() && queue.length) { const batch = queue.splice(0, 4); await Promise.all(batch.map(key => run(key, 'refresh'))) }", assertion: 'allows completed slots to read later participants while one Host stays slow' },
  'hidden-generation': { file: 'use-collaboration-reading.ts', from: 'const current = () => token === generation.current', to: 'const current = () => true', assertion: 'never starts queued participants or follows observer hints after hiding' },
  'exact-event-source': { file: 'use-collaboration-reading.ts', from: "if (page.hostId !== subject.hostId || page.participantSessionId !== subject.agentSessionId) throw new Error('The original message Host or participant did not match.')", to: '', assertion: 'retains readable events on wrong-source and failed reads and exposes retry on the original identity' },
  'initial-observation': { file: 'use-collaboration-reading.ts', from: "'Automatic updates are unconfirmed. Refresh the original source.'", to: 'null', assertion: 'starts observation as unknown, scopes state by Host, and never animates catch-up or duplicate records' },
  'source-watermark-reset': { file: 'use-collaboration-reading.ts', from: 'wanted.delete(key); pulseThrough.delete(subject.hostId); livePulses = livePulses.filter(pulse => pulse.hostId !== subject.hostId); expirePulses()', to: '', assertion: 'expires old observer sequence watermarks when explicit refresh accepts another journal incarnation' },
  'initial-watermark-reset': { file: 'use-collaboration-reading.ts', from: 'latest && previous.incarnation !== null && previous.incarnation !== page.incarnation', to: 'latest && previous.incarnation !== page.incarnation', assertion: 'retains a newer observer hint received while the very first latest window is in flight' },
  'catchup-is-live': { file: 'use-collaboration-reading.ts', from: 'event.live && event.sequence >', to: 'event.sequence >', assertion: 'starts observation as unknown, scopes state by Host, and never animates catch-up or duplicate records' },
  'journal-evidence': { file: 'agent-collaboration.ts', from: 'JSON.stringify([hostId, reading.incarnation, ref.messageId])', to: 'JSON.stringify([hostId, ref.messageId])', assertion: 'keeps same MID in different incarnations separate and keeps different Hosts as different Agents' },
  'participant-event-dedup': { file: 'agent-collaboration.ts', from: 'if (!events.has(sequence)) events.set(sequence, event)', to: 'events.set(events.size, event)', assertion: 'deduplicates both participant reads and notification references by original MID and journal while preserving direction' },
  'pulse-demand-phase': { file: 'use-collaboration-reading.ts', from: 'let livePulses = activity.current.pulses', to: 'let livePulses: CollaborationPulse[] = []', assertion: 'keeps a live pulse phase and original observer watermark while active viewport demand changes' },
  'pulse-demand-watermark': { file: 'use-collaboration-reading.ts', from: 'pulseThrough = activity.current.through', to: 'pulseThrough = new Map<string, number>()', assertion: 'keeps a live pulse phase and original observer watermark while active viewport demand changes' },
  'facts-status-stability': { file: 'use-collaboration-reading.ts', from: 'if (!fact || fact.incarnation !== next.incarnation || fact.events !== next.events || fact.spawns !== next.spawns)', to: 'if (true)', assertion: 'retains the exact facts through status-only loading failure observation and pulse expiration' },
  'retained-demand-window': { file: 'use-collaboration-reading.ts', from: 'const held = { ...previousSources }', to: 'const held: Record<string, CollaborationSource> = {}', assertion: 'retains loaded A history while B is demanded and resumes A without an initial query' },
  'incremental-original-pages': { file: 'agent-collaboration.ts', from: 'const eventPages = reset ? [reading.events] : changes.reverse().map(change => change.events)', to: 'const eventPages = [reading.events]', assertion: 'decodes only a new original page after ten thousand real accumulated rows and leaves other sources stable' },
  'foreign-runtime-route': { file: 'agent-collaboration.ts', from: 'subject: null, sessionId: creator.agentSessionId', to: 'subject: { hostId, agentSessionId: creator.agentSessionId }, sessionId: creator.agentSessionId', assertion: 'keeps foreign Runtime creation provenance unresolved instead of impersonating a Desktop Host route' }
}
const selected = process.env.AGENTMUX_COLLABORATION_READING_MUTANT
if (selected && !collaborationReadingMutations[selected]) throw new Error('Unknown collaboration reading mutant: ' + selected)
let loaded = false
export default defineConfig({ ...base, cacheDir: '.cache/collaboration-reading', plugins: [...base.plugins!, {
  name: 'collaboration-reading-source-proof', enforce: 'pre', transform(source, id) {
    const file = relative(process.cwd(), id.split('?')[0]!)
    if (!file.startsWith('apps/desktop/src/') && !file.startsWith('packages/')) return
    const mutation = selected ? collaborationReadingMutations[selected]! : undefined
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
