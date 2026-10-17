import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import shared from '../scripts/fixtures/agent-information-card/vitest.owning.config.mts'

const references = 'keeps unrelated whole node and geometry references through selection and metadata-only relation updates'
const detour = 'renders and selects a real corridor detour while both original endpoint cards are offscreen'
export const collaborationCanvasMutations = [
  { name: 'declared-fixed-node', before: 'measured: { width: card.width, height: card.height }, handles: emptyHandles,', after: 'measured: { width: card.width, height: card.height },', assertion: 'the actual Graph and original xyflow mount only visible production cards from a large fixed world' },
  { name: 'whole-node-reference', before: 'const node: AgentNode = old?.box === card', after: 'const node: AgentNode = false && old?.box === card', assertion: references },
  { name: 'metadata-route-reuse', before: 'const route = previous?.from === from', after: 'const route = false && previous?.from === from', assertion: references },
  { name: 'endpoint-only-culling', before: 'return paths.filter(({ route: { bounds } }) => bounds.x <= right && bounds.x + bounds.width >= left && bounds.y <= bottom && bounds.y + bounds.height >= top)',
    after: 'return paths.filter(({ route: { points } }) => Math.min(points[0]!.x, points.at(-1)!.x) <= right && Math.max(points[0]!.x, points.at(-1)!.x) >= left && Math.min(points[0]!.y, points.at(-1)!.y) <= bottom && Math.max(points[0]!.y, points.at(-1)!.y) >= top)', assertion: detour },
  { name: 'original-pointer-selection', before: 'onClick={event => { event.stopPropagation(); onSelect(record) }}', after: 'onClick={event => { event.stopPropagation() }}', assertion: detour },
  { name: 'original-keyboard-selection', before: 'event.preventDefault(); event.stopPropagation(); onSelect(record)', after: 'event.preventDefault(); event.stopPropagation()', assertion: detour },
  { name: 'real-arrow-definition', before: 'id={`${markerId}-${kind}`}', after: 'id={`${markerId}-${kind}-missing`}', assertion: detour },
  { name: 'stable-activity-phase', before: 'useMemo(() => Math.min(0, record.startedAt - Date.now()), [record.active, record.startedAt])', after: 'Math.min(0, record.startedAt - Date.now())', assertion: 'keeps an original pulse phase through selection and resumes only its elapsed phase after viewport remount' }
] as const
const selected = process.env.AGENTMUX_COLLABORATION_CANVAS_MUTATION
const mutation = collaborationCanvasMutations.find(item => item.name === selected)
if (selected && !mutation) throw Error('Unknown collaboration canvas mutation')
const hash = (source: string) => createHash('sha256').update(source).digest('hex')
let loaded = false
export default defineConfig({ ...shared, cacheDir: '.cache/collaboration-canvas', plugins: [...shared.plugins ?? [], {
  name: 'collaboration-canvas-source-proof', enforce: 'pre', transform(source, id) {
    const path = relative(process.cwd(), id.split('?')[0]!)
    if (!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/')) return
    const applied = mutation && path === 'apps/desktop/src/renderer/src/components/AgentCollaborationGraph.tsx'
    let code = source
    if (applied) {
      if (code.split(mutation.before).length !== 2) throw Error('Unique canvas mutation anchor required')
      code = code.replace(mutation.before, mutation.after); loaded = true
    }
    if (process.env.AGENTMUX_COLLABORATION_CANVAS_LOADED) appendFileSync(process.env.AGENTMUX_COLLABORATION_CANVAS_LOADED,
      JSON.stringify({ path, originalSHA256: hash(source), effectiveSHA256: hash(code), mutant: applied ? selected : null }) + '\n')
    if (source !== code) return { code, map: null }
  }, buildEnd() { if (selected && !loaded) throw Error('The actual canvas mutation source must be loaded') }
}], test: { ...shared.test, include: ['apps/desktop/test/collaboration-canvas-product.test.tsx'], passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 20000 } })
