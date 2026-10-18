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
  { file: graph, name: 'visible-message-packet', before: "record.active && kind === 'communication' ? <circle", after: 'false ? <circle', assertion: 'shows immediate source and recipient activity while the original new path is still arriving' },
  { file: graph, name: 'original-packet-phase', before: 'offsetPath: `path("${path}")`, animationDelay: `${delay}ms`', after: 'offsetPath: `path("${path}")`, animationDelay: "0ms"', assertion: 'shows immediate source and recipient activity while the original new path is still arriving' },
  { file: graph, name: 'screen-sized-message-packet', before: 'r={4 / zoom}', after: 'r={4}', assertion: 'shows immediate source and recipient activity while the original new path is still arriving' },
  { file: graph, name: 'named-overview-region', before: '<span>{data.area.name}</span><small>{data.area.members.length}</small>', after: '<span /><small>{data.area.members.length}</small>', assertion: 'keeps named region labels separated at distant scale without changing world geometry' },
  { file: graph, name: 'region-label-separation', before: '...placed.filter(other => collaborationBoundsOverlap(padded, other)), ', after: '', assertion: 'keeps named region labels separated at distant scale without changing world geometry' },
  { file: graph, name: 'region-agent-hit-clearance', before: '...blockingAgents(label)', after: '...[]', assertion: 'keeps projected region labels clear of original Agent hit targets through camera LOD' },
  { file: graph, name: 'offscreen-region-context', before: 'if (!overview && (headingVisible || !visibleAreas.has(box.id))) return []', after: 'if (!overview) return []', assertion: 'retains exact region context when reading a member with its original heading offscreen' },
  { file: graph, name: 'original-route-diagnostic', before: '{message}</p>)}</details>', after: '{null}</p>)}</details>', assertion: 'keeps local route diagnostics inspectable and retries only the failed original connection' },
  { file: graph, name: 'current-parent-origin', before: 'previous?.position.x === card.x - box.x && previous.position.y === card.y - box.y && ', after: '', assertion: 'adopts parent-relative positions when a local resize expands the original area toward the left' },
  { file: graph, name: 'current-envelope-members', before: 'old?.box === box && sameGeometry ? old.envelope', after: 'old?.box === box ? old.envelope', assertion: 'rebuilds the real envelope when current members change inside identical enclosing bounds' },
  { file: graph, name: 'immediate-message-mark', before: '{data.activity ? <ActivityMark activity={data.activity} /> : null}', after: '{null}', assertion: 'shows immediate source and recipient activity while the original new path is still arriving' },

  { file: 'components/AgentInformationPreview.tsx', name: 'metadata-reading-continuity', before: "if (!becameAvailable || !enabled || previewTrigger === 'keyboard') return", after: 'return', assertion: 'keeps the original point and actual focus through first metadata without replaying keyboard-only reading' },
  { file: graph, name: 'replayed-highlight-reading', before: 'const preview = useAgentInformationPreview(context, true, data.identity, data.goals, () => { if (context) data.onOpen(context.id) })', after: 'const preview = useAgentInformationPreview(context, true, data.identity, data.goals, () => { if (context) data.onOpen(context.id) }); useEffect(() => { preview.triggerEvents.onPointerEnter() }, [])', assertion: 'overview remount never replays a retained relationship highlight as a new reading intent' },
  { file: graph, name: 'overview-heading-clearance', before: 'top + box.heading.height * zoom - 26', after: 'top', assertion: 'overview keeps exact Agent endpoints without relayout and enters a named region through its control' },
  { file: 'lib/collaboration-map-geometry.ts', name: 'envelope-member-extents', before: '{ ...box, x: box.x - area.x, y: box.y - area.y }', after: '{ ...box, x: box.x - area.x, y: box.y - area.y, width: 0, height: 0 }', assertion: 'encloses complete member corners and the exact heading without a rectangular frame' },
  { file: graph, name: 'selected-group-detail', before: 'new Set([selection.id, ...selection.relatedIds ?? []])', after: 'new Set([selection.id])', assertion: 'keeps every selected original relation emphasized when an explicitly folded group expands' },
  { file: graph, name: 'initial-world-fit', before: 'void flow.setCenter(target.x, target.y, { zoom: target.zoom })', after: 'void flow.fitView({ minZoom: .05, maxZoom: .95, includeHiddenNodes: true })', assertion: 'opens a real working region at readable scale instead of fitting many empty regions' },
  { file: graph, name: 'overview-original-projection', before: 'collaborationOverviewPath(record.route, record.sourceBox, record.targetBox, zoom)', after: 'record.route.path', assertion: 'overview keeps exact Agent endpoints without relayout and enters a named region through its control' },
  { file: graph, name: 'complete-member-envelope', before: 'collaborationEnvelope(box, memberGeometry)', after: "''", assertion: 'overview keeps exact Agent endpoints without relayout and enters a named region through its control' },
  { file: graph, name: 'related-path-emphasis', before: "selected || related ? 'related' : 'muted'", after: "selected ? 'related' : 'muted'", assertion: 'selecting an Agent highlights only its original relations while preserving every other connection' },
  { file: graph, name: 'declared-fixed-node', before: 'measured: { width: card.width, height: card.height }, handles: emptyHandles,', after: 'measured: { width: card.width, height: card.height },', assertion: 'the actual Graph and original xyflow mount only visible production cards from a large Worker world' },
  { file: graph, name: 'whole-node-reference', before: 'const node: AgentNode = old?.box === card', after: 'const node: AgentNode = false && old?.box === card', assertion: references },
  { file: graph, name: 'exact-metadata-node', before: 'old.agent === agent', after: 'true', assertion: metadata },
  { file: graph, name: 'metadata-is-geometry', before: "...collaborationNodeSize(agent.tier ?? (agent.context ? 'active' : 'unknown'))", after: "...{ ...collaborationNodeSize(agent.tier ?? (agent.context ? 'active' : 'unknown')), width: 250 + (agent.name?.length ?? 0) }", assertion: metadata },
  { file: graph, name: 'readable-card-lod', before: "agent.context && tier === 'active' && readable", after: "agent.context && tier === 'active'", assertion: 'keeps every world member through viewport LOD while mounting full shared cards only at readable zoom' },
  { file: graph, name: 'endpoint-only-culling', before: 'return paths.filter(({ route: { bounds }, sourceBox, targetBox }) => [bounds, sourceBox, targetBox].some(box => box.x <= right && box.x + box.width >= left && box.y <= bottom && box.y + box.height >= top))',
    after: 'return paths.filter(({ route: { points } }) => Math.min(points[0]!.x, points.at(-1)!.x) <= right && Math.max(points[0]!.x, points.at(-1)!.x) >= left && Math.min(points[0]!.y, points.at(-1)!.y) <= bottom && Math.max(points[0]!.y, points.at(-1)!.y) >= top)', assertion: detour },
  { file: graph, name: 'original-pointer-selection', before: 'onClick={event => { event.stopPropagation(); onSelect(record) }}', after: 'onClick={event => { event.stopPropagation() }}', assertion: detour },
  { file: graph, name: 'original-keyboard-selection', before: 'event.preventDefault(); event.stopPropagation(); onSelect(record)', after: 'event.preventDefault(); event.stopPropagation()', assertion: detour },
  { file: graph, name: 'real-arrow-definition', before: 'id={`${markerId}-${kind}`}', after: 'id={`${markerId}-${kind}-missing`}', assertion: detour },
  { file: graph, name: 'stable-activity-phase', before: 'useMemo(() => Math.min(0, record.startedAt - Date.now()), [record.active, record.startedAt])', after: 'Math.min(0, record.startedAt - Date.now())', assertion: 'keeps an original pulse phase through selection and resumes only its elapsed phase after viewport remount' },
  { file: graph, name: 'prepared-locate-token', before: 'preparedLocate.current === locate.token', after: 'false', assertion: 'locates a member inside a folded area once and preserves a later user fold through metadata changes' },
  { file: graph, name: 'explicit-camera-intent', before: '++gestures.current; void flow.current?.zoomIn()', after: 'void flow.current?.zoomIn()', assertion: 'keeps explicit Zoom and Fit intent when original Worker placement arrives after the button click' },
  { file: graph, name: 'reading-exact-occurrence', before: 'readingAnchor.current = nodeId; actions.current.onSelect', after: 'readingAnchor.current = collaborationAgentNode(graphAreas[0]!.id, id); actions.current.onSelect', assertion: 'keeps the exact reading occurrence and translates all curves through an explicit rearrangement' },
  { file: graph, name: 'keyboard-reading-occurrence', before: ' onFocusCapture={() => data.onPreview(true)}', after: '', assertion: 'keeps keyboard reading anchored then honors the last actual pointer during a later size job without another request' },
  { file: graph, name: 'keyboard-preview-release', before: 'if (!event.currentTarget.contains(event.relatedTarget)) data.onPreview(false)', after: 'void event.relatedTarget', assertion: 'keeps keyboard reading anchored then honors the last actual pointer during a later size job without another request' },
  { file: graph, name: 'folded-heading-anchor', before: 'readingAnchor.current = areaId; setFolded', after: 'setFolded', assertion: 'preserves the clicked area heading through folding and unfolding without resurrecting the prior Agent anchor' },
  { file: 'lib/use-collaboration-layout.ts', name: 'untranslated-reading-path', before: 'next.set(key, translateCollaborationPath(path, offset))', after: 'next.set(key, path)', assertion: 'keeps the exact reading occurrence and translates all curves through an explicit rearrangement' },
  { file: 'lib/collaboration-layout-engine.ts', name: 'translated-path-metadata', before: 'labelX: path.labelX + offset.x, labelY: path.labelY + offset.y,\n    bounds: { ...path.bounds, x: path.bounds.x + offset.x, y: path.bounds.y + offset.y }', after: 'labelX: path.labelX, labelY: path.labelY,\n    bounds: path.bounds', assertion: 'keeps the exact reading occurrence and translates all curves through an explicit rearrangement' },
  { file: 'lib/collaboration-layout-engine.ts', name: 'translated-path-controls', before: 'const points = path.points.map(point => ({ x: point.x + offset.x, y: point.y + offset.y }))', after: 'const points = path.points', assertion: 'keeps the exact reading occurrence and translates all curves through an explicit rearrangement' }
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
}], test: { ...shared.test, include: ['apps/desktop/test/collaboration-canvas-product.test.tsx', 'apps/desktop/test/collaboration-map-geometry.test.ts'], passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 20000 } })
