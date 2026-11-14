import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import shared from '../scripts/fixtures/agent-information-card/vitest.owning.config.mts'

export const stableSlotMutations = [
  { name: 'live-size-reflow', before: 'slotSizes.current.get(nodeId) ?? collaborationNodeSize(', after: 'collaborationNodeSize(', test: 'keeps exact occurrence slots' },
  { name: 'compact-body-overflow', before: 'agent.context && collaborationCardSlot(data.box) ? lod.detail : 0', after: 'agent.context ? lod.detail : 0', test: 'keeps exact occurrence slots' },
  { name: 'missing-time-becomes-cold', before: 'knownTime ? steps.get(id) : undefined', after: 'steps.get(id)', test: 'does not treat missing activity time' },
  { name: 'arrange-keeps-old-sizes', before: 'slotSizes.current.clear(); setSlotRevision', after: 'setSlotRevision', test: 'resizes known quiet and active slots' },
  { name: 'old-idle-reserves-name-slot', file: 'lib/collaboration-map-presentation.ts', before: "tier === 'closed' || tier === 'idle' && step === 'older'", after: "tier === 'closed'", test: 'keeps exact occurrence slots' }
] as const
const selected = process.env.AGENTMUX_STABLE_MAP_MUTATION
const mutation = stableSlotMutations.find(value => value.name === selected)
if (selected && !mutation) throw Error('Unknown stable Map mutation')
let mutated = false
const hash = (source: string) => createHash('sha256').update(source).digest('hex')
export default defineConfig({ ...shared, cacheDir: '.cache/focus-map-stable-slots', plugins: [...shared.plugins ?? [], {
  name: 'actual-stable-map-source', enforce: 'pre', transform(source, id) {
    const path = relative(process.cwd(), id.split('?')[0]!)
    if (!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/')) return
    let code = source
    const file = mutation && 'file' in mutation ? mutation.file : 'components/AgentCollaborationGraph.tsx'
    const applied = mutation && path === 'apps/desktop/src/renderer/src/' + file
    if (applied) {
      if (code.split(mutation.before).length !== 2) throw Error('One exact stable Map mutation anchor required')
      code = code.replace(mutation.before, mutation.after); mutated = true
    }
    if (process.env.AGENTMUX_STABLE_MAP_LOADED) appendFileSync(process.env.AGENTMUX_STABLE_MAP_LOADED,
      JSON.stringify({ path, sourceSHA256: hash(source), effectiveSHA256: hash(code), mutation: applied ? selected : null }) + '\n')
    return source !== code ? { code, map: null } : undefined
  }, buildEnd() { if (selected && !mutated) throw Error('The real stable Map mutation must be loaded') }
}], test: { ...shared.test, pool: 'threads', include: ['apps/desktop/test/focus-map-stable-slots.test.tsx'], passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 15000 } })
