import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import shared from '../scripts/fixtures/agent-information-card/vitest.owning.config.mts'

const references = 'keeps unrelated whole node references and camera through selection and metadata-only relation updates'
const detour = 'renders and selects an actual Worker detour while both original endpoint cards are offscreen'
const graph = 'components/AgentCollaborationGraph.tsx'
const metadata = 'rebuilds only one exact offscreen Agent node for metadata without another layout job or unrelated card render'
export const collaborationCanvasMutations = [
  { file: graph, name: 'selected-group-detail', before: 'new Set([selection.id, ...selection.relatedIds ?? []])', after: 'new Set([selection.id])', assertion: 'keeps every selected original relation emphasized when an overview group expands into detail' },
  { file: graph, name: 'initial-world-fit', before: 'void flow.setCenter(target.x, target.y, { zoom: target.zoom })', after: 'void flow.fitView({ minZoom: .05, maxZoom: .95, includeHiddenNodes: true })', assertion: 'opens a real working region at readable scale instead of fitting many empty regions' },
  { file: graph, name: 'overview-original-projection', before: 'const ids = zoom < COLLABORATION_OVERVIEW_ZOOM ? overviewPathIds : detailPathIds', after: 'const ids = detailPathIds', assertion: 'overview groups original directional relations without relayout and enters a named region through its control' },
  { file: graph, name: 'related-path-emphasis', before: "selected || related ? 'related' : 'muted'", after: "selected ? 'related' : 'muted'", assertion: 'selecting an Agent highlights only its original relations while preserving every other connection' },
  { file: graph, name: 'declared-fixed-node', before: 'measured: { width: card.width, height: card.height }, handles: emptyHandles,', after: 'measured: { width: card.width, height: card.height },', assertion: 'the actual Graph and original xyflow mount only visible production cards from a large Worker world' },
  { file: graph, name: 'whole-node-reference', before: 'const node: AgentNode = old?.box === card', after: 'const node: AgentNode = false && old?.box === card', assertion: references },
  { file: graph, name: 'exact-metadata-node', before: 'old.agent === agent', after: 'true', assertion: metadata },
  { file: graph, name: 'metadata-is-geometry', before: "...collaborationNodeSize(agent.tier ?? (agent.context ? 'active' : 'unknown'))", after: "...{ ...collaborationNodeSize(agent.tier ?? (agent.context ? 'active' : 'unknown')), width: 250 + (agent.name?.length ?? 0) }", assertion: metadata },
  { file: graph, name: 'readable-card-lod', before: "agent.context && tier === 'active' && readable", after: "agent.context && tier === 'active'", assertion: 'keeps every world member through viewport LOD while mounting full shared cards only at readable zoom' },
  { file: graph, name: 'endpoint-only-culling', before: 'return paths.filter(({ id, route: { bounds } }) => ids.has(id) && bounds.x <= right && bounds.x + bounds.width >= left && bounds.y <= bottom && bounds.y + bounds.height >= top)',
    after: 'return paths.filter(({ id, route: { points } }) => ids.has(id) && Math.min(points[0]!.x, points.at(-1)!.x) <= right && Math.max(points[0]!.x, points.at(-1)!.x) >= left && Math.min(points[0]!.y, points.at(-1)!.y) <= bottom && Math.max(points[0]!.y, points.at(-1)!.y) >= top)', assertion: detour },
  { file: graph, name: 'original-pointer-selection', before: 'onClick={event => { event.stopPropagation(); onSelect(record) }}', after: 'onClick={event => { event.stopPropagation() }}', assertion: detour },
  { file: graph, name: 'original-keyboard-selection', before: 'event.preventDefault(); event.stopPropagation(); onSelect(record)', after: 'event.preventDefault(); event.stopPropagation()', assertion: detour },
  { file: graph, name: 'real-arrow-definition', before: 'id={`${markerId}-${kind}`}', after: 'id={`${markerId}-${kind}-missing`}', assertion: detour },
  { file: graph, name: 'stable-activity-phase', before: 'useMemo(() => Math.min(0, record.startedAt - Date.now()), [record.active, record.startedAt])', after: 'Math.min(0, record.startedAt - Date.now())', assertion: 'keeps an original pulse phase through selection and resumes only its elapsed phase after viewport remount' },
  { file: graph, name: 'prepared-locate-token', before: 'preparedLocate.current === locate.token', after: 'false', assertion: 'locates a member inside a folded area once and preserves a later user fold through metadata changes' },
  { file: graph, name: 'explicit-camera-intent', before: '++gestures.current; void flow.current?.zoomIn()', after: 'void flow.current?.zoomIn()', assertion: 'keeps explicit Zoom and Fit intent when original Worker placement arrives after the button click' },
  { file: graph, name: 'reading-exact-occurrence', before: 'readingAnchor.current = nodeId; actions.current.onSelect', after: 'readingAnchor.current = collaborationAgentNode(graphAreas[0]!.id, id); actions.current.onSelect', assertion: 'anchors the clicked exact occurrence through a real size transition and translates every original curve consistently' },
  { file: graph, name: 'keyboard-reading-occurrence', before: ' onFocusCapture={() => data.onPreview(true)}', after: '', assertion: 'keeps keyboard reading anchored then honors the last actual pointer during a later size job without another request' },
  { file: 'lib/use-collaboration-layout.ts', name: 'invalidated-reading-occurrence', before: 'else if (anchor) readingAnchor.current = null', after: 'else if (anchor) void readingAnchor.current', assertion: 'records a legal Locate occurrence and drops its anchor when that exact occurrence is later folded' },
  { file: 'lib/use-collaboration-layout.ts', name: 'untranslated-reading-path', before: 'next.set(key, translateCollaborationPath(path, offset))', after: 'next.set(key, path)', assertion: 'anchors the clicked exact occurrence through a real size transition and translates every original curve consistently' },
  { file: 'lib/collaboration-layout-engine.ts', name: 'translated-path-metadata', before: 'labelX: path.labelX + offset.x, labelY: path.labelY + offset.y,\n    bounds: { ...path.bounds, x: path.bounds.x + offset.x, y: path.bounds.y + offset.y }', after: 'labelX: path.labelX, labelY: path.labelY,\n    bounds: path.bounds', assertion: 'anchors the clicked exact occurrence through a real size transition and translates every original curve consistently' },
  { file: 'lib/collaboration-layout-engine.ts', name: 'translated-path-controls', before: 'const points = path.points.map(point => ({ x: point.x + offset.x, y: point.y + offset.y }))', after: 'const points = path.points', assertion: 'anchors the clicked exact occurrence through a real size transition and translates every original curve consistently' }
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
    const applied = mutation && path === 'apps/desktop/src/renderer/src/' + mutation.file
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
