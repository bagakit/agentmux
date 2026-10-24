// @vitest-environment happy-dom
import { act, useLayoutEffect, type ComponentProps, type ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { Node, ReactFlowProps, useStoreApi } from '@xyflow/react'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { installCollaborationCanvasGeometry } from './helpers/collaboration-canvas-dom'
import { installCollaborationLayoutLoopback, settleCollaborationCanvas } from './helpers/collaboration-layout-loopback'
import { AgentCollaborationGraph, type CollaborationSelection } from '../src/renderer/src/components/AgentCollaborationGraph'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { collaborationAgents, collaborationSubjectKey, type CollaborationAgent, type CollaborationArea, type CollaborationRelation } from '../src/renderer/src/lib/agent-collaboration'
import { collaborationAgentNode } from '../src/renderer/src/lib/collaboration-presentation'
import { CollaborationBoundsIndex, collaborationBoundsOverlap } from '../src/renderer/src/lib/collaboration-spatial-index'
import * as engine from '../src/renderer/src/lib/collaboration-layout-engine'
import type { CollaborationPulse } from '../src/renderer/src/lib/use-collaboration-reading'
import { COLLABORATION_ACTIVITY_MS, collaborationAgentGlyph } from '../src/renderer/src/lib/collaboration-map-presentation'
import { collaborationVisiblePath } from '../src/renderer/src/lib/collaboration-map-geometry'
import { agentInformationPreview } from '../src/renderer/src/lib/agent-information-preview'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { applyConfigEdit } from '../src/shared/config-edit'
import { DEFAULT_MOTE_FACE } from '../src/shared/mote-avatars'
import collaborationCSS from '../src/renderer/src/styles/collaboration.css?inline'
const captured = vi.hoisted(() => ({ nodes: [] as Node[], store: null as ReturnType<typeof useStoreApi> | null, cardRenders: [] as string[], moveStart: undefined as ReactFlowProps['onMoveStart'] }))
vi.mock('../src/renderer/src/components/FocusContextCardBody', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/renderer/src/components/FocusContextCardBody')>()
  return { ...actual, FocusContextCardBody: (props: ComponentProps<typeof actual.FocusContextCardBody>) => {
    captured.cardRenders.push(props.context.id)
    return <actual.FocusContextCardBody {...props} />
  } }
})
vi.mock('@xyflow/react', async importOriginal => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()
  function ObserveOriginalStore() {
    const store = actual.useStoreApi()
    useLayoutEffect(() => { captured.store = store }, [store]); return null
  }
  return { ...actual, ReactFlow: ({ children, ...props }: ReactFlowProps & { children?: ReactNode }) => {
    captured.nodes = props.nodes ?? []
    captured.moveStart = props.onMoveStart
    return <actual.ReactFlow {...props}>{children}<ObserveOriginalStore /></actual.ReactFlow>
  } }
})
const dom = composerDOM({ agentInformation: true }), select = vi.fn(), open = vi.fn()
const originalDispatch = engine.handleCollaborationLayoutRequest
const subject = (id: string) => collaborationSubjectKey({ hostId: 'local', agentSessionId: id })
function scenario(count = 480) {
  const contexts = Array.from({ length: count }, (_, i) => agentContextForSession(composerSession(`canvas-${i}`), undefined, `Agent ${i}`, undefined, null))
  const agents = collaborationAgents(contexts)
  const areas: CollaborationArea[] = Array.from({ length: 4 }, (_, index) => ({ id: `area-${index}`, kind: 'project', name: `Original area ${index}`, members: contexts.filter((_, at) => at % 4 === index).map(context => subject(context.id)) }))
  const relations: CollaborationRelation[] = count === 24 ? contexts.filter((_, index) => index % 3 === 0).flatMap((context, index) => [
    { id: `local-${index}`, kind: 'communication', source: subject(context.id), target: subject(contexts[(index * 3 + 4) % count]!.id), evidence: [] },
    { id: `cross-${index}`, kind: 'supervision', source: subject(context.id), target: subject(contexts[(index * 3 + 1) % count]!.id), evidence: [] }
  ]) : [{ id: 'original-relation', kind: 'communication', source: subject('canvas-0'), target: subject('canvas-1'), evidence: [] }]
  return { contexts, agents, areas, relations }
}
type Scene = ReturnType<typeof scenario>
let requests: engine.CollaborationLayoutRequest[], boxes: Map<string, engine.CollaborationLayoutBox>, paths: Map<string, engine.CollaborationPath>
let holdResponses = false, heldResponses: { response: engine.CollaborationLayoutResponse; deliver(): void }[] = []
function graph(scene: Scene, selection: CollaborationSelection = null, relations: readonly CollaborationRelation[] = scene.relations, pulses: readonly CollaborationPulse[] = [], agents: ReadonlyMap<string, CollaborationAgent> = scene.agents, options: Pick<ComponentProps<typeof AgentCollaborationGraph>, 'ready' | 'active' | 'locate' | 'context' | 'onPreviewAgent' | 'peeked'> = {}) {
  return <AgentCollaborationGraph agents={agents} areas={scene.areas} relations={relations} pulses={pulses} selection={selection} onSelect={select} onOpen={open} ready={false} {...options} />
}
async function viewport(x: number, y: number, width = 600, height = 400, zoom = 1) {
  await act(async () => captured.store!.setState({ width, height, transform: [x, y, zoom] }))
}
async function revealWorld() {
  const extent = [...boxes.values()]
  await viewport(-Math.min(...extent.map(box => box.x)) + 20, -Math.min(...extent.map(box => box.y)) + 20, 20000, 20000)
}
async function loaded(scene: Scene) {
  await dom.render(graph(scene))
  await settleCollaborationCanvas(() => {
    expect(captured.nodes).toHaveLength(scene.areas.reduce((sum, area) => sum + area.members.length + 1, 0))
    expect(dom.container.querySelector('.collaboration-canvas__progress')).toBeNull()
    expect(dom.container.querySelector('.collaboration-canvas__issue')).toBeNull()
    if (scene.relations.length) expect(paths.size).toBeGreaterThan(0)
    else expect(paths.size).toBe(0)
  })
}
async function loadedDetourScene() {
  const scene = scenario(24); scene.relations = []
  await loaded(scene)
  const members = [...boxes.values()].filter(box => box.kind === 'agent')
  const candidates = members.flatMap((source, index) => members.slice(index + 1).flatMap(target => {
    const dx = Math.abs(source.x - target.x), dy = Math.abs(source.y - target.y)
    if (Math.max(dx, dy) < 250) return []
    return [{ source, target, alignment: Math.min(dx, dy) / Math.max(dx, dy), distance: Math.hypot(dx, dy) }]
  })).sort((a, b) => a.alignment - b.alignment || b.distance - a.distance)
  // Choose an input from the actual new world, not an accidental coordinate in
  // the old force solver. The Graph still receives and draws its own Worker route.
  let chosen: typeof candidates[number] | undefined
  for (const candidate of candidates.slice(0, 48)) {
    const [path] = await engine.routeCollaborationLayout([...boxes.values()], [{ id: 'probe', kind: 'communication', source: candidate.source.id, target: candidate.target.id }])
    if (path && pathDetour(path, candidate.source, candidate.target)) { chosen = candidate; break }
  }
  expect(chosen, 'The actual placed world must offer a real obstructed route').toBeDefined()
  const source = captured.nodes.find(node => node.id === chosen!.source.id)!.data.agent as CollaborationAgent
  const target = captured.nodes.find(node => node.id === chosen!.target.id)!.data.agent as CollaborationAgent
  const originalBoxes = boxes
  scene.relations = [{ id: 'original-obstructed-message', kind: 'communication', source: source.id, target: target.id, evidence: [] }]
  await dom.render(graph(scene))
  await settleCollaborationCanvas(() => {
    expect(requests.at(-1)?.type).toBe('route'); expect(paths.size).toBe(1)
    expect(dom.container.querySelector('.collaboration-canvas__progress')).toBeNull()
    expect(dom.container.querySelector('.collaboration-canvas__issue')).toBeNull()
  })
  expect(boxes).toBe(originalBoxes)
  expect([...paths.values()][0]!.points.length).toBeGreaterThan(4)
  return scene
}
async function focusNode(id: string) {
  const box = renderedBox(id)
  await viewport(-box.x + 20, -box.y + 20, 520, 300)
}
function renderedBox(id: string) {
  const node = captured.nodes.find(node => node.id === id)
  expect(node).toBeDefined()
  return node!.data.box as engine.CollaborationLayoutBox
}
function nodeElement(id: string) { return [...dom.container.querySelectorAll('.react-flow__node')].find(element => element.getAttribute('data-id') === id) }
async function pointAt(id: string) {
  await focusNode(id)
  const mark = nodeElement(id)!.querySelector('.collaboration-agent')!
  await act(async () => { mark.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })) })
}
async function releasePlacement() {
  await act(async () => { holdResponses = false; const pending = heldResponses; heldResponses = []; for (const item of pending) item.deliver() })
  await settleCollaborationCanvas(() => expect(dom.container.querySelector('.collaboration-canvas__progress')).toBeNull())
}
const boxIntersects = (box: engine.CollaborationLayoutBox, x: number, y: number, size: number) => box.x < x + size && box.x + box.width > x && box.y < y + size && box.y + box.height > y
function curvePoints(path: string) {
  const numbers = path.match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/giu)!.map(Number)
  return numbers.flatMap((number, index) => index % 2 ? [] : [{ x: number, y: numbers[index + 1]! }])
}
/** At reading scale the complete raw curve remains, with optional terminal
 * connectors to the rounded visible bodies. Both projections must translate. */
function expectAnchoredVisibleCurve(rawPath: engine.CollaborationPath, curve: ReturnType<typeof curvePoints>, offset: { x: number; y: number }) {
  const connection = requests.flatMap(request => request.type === 'route' ? request.connections : request.input.connections).find(connection => connection.id === rawPath.id)!
  expect(connection).toBeDefined()
  const sourceGlyph = collaborationAgentGlyph(captured.nodes.find(node => node.id === connection.source)!.data.agent as CollaborationAgent)
  const targetGlyph = collaborationAgentGlyph(captured.nodes.find(node => node.id === connection.target)!.data.agent as CollaborationAgent)
  const projected = curvePoints(collaborationVisiblePath(rawPath, boxes.get(connection.source)!, boxes.get(connection.target)!, 1,
    sourceGlyph.overviewRadius, targetGlyph.overviewRadius, sourceGlyph.pointRadius, targetGlyph.pointRadius))
  expect(curve).toHaveLength(projected.length)
  for (const [index, point] of curve.entries()) {
    expect(point.x).toBeCloseTo(projected[index]!.x + offset.x, 7)
    expect(point.y).toBeCloseTo(projected[index]!.y + offset.y, 7)
  }
  // Independently retain every original raw control/port in order. Sharing the
  // projection cannot let that projection silently replace the safe middle.
  expect(curve.some((_, start) => start + rawPath.points.length <= curve.length && rawPath.points.every((point, index) =>
    Math.abs(curve[start + index]!.x - point.x - offset.x) < 1e-7 && Math.abs(curve[start + index]!.y - point.y - offset.y) < 1e-7))).toBe(true)
  const translated = engine.translateCollaborationPath(rawPath, offset)
  expect(translated.points).toHaveLength(rawPath.points.length)
  for (const [index, point] of translated.points.entries()) {
    expect(point.x).toBeCloseTo(rawPath.points[index]!.x + offset.x, 8)
    expect(point.y).toBeCloseTo(rawPath.points[index]!.y + offset.y, 8)
  }
  expect(translated.id).toBe(rawPath.id); expect(translated.sourceHandle).toBe(rawPath.sourceHandle); expect(translated.targetHandle).toBe(rawPath.targetHandle)
  expect(translated.bounds).toEqual({ ...rawPath.bounds, x: rawPath.bounds.x + offset.x, y: rawPath.bounds.y + offset.y })
  expect([translated.labelX, translated.labelY]).toEqual([rawPath.labelX + offset.x, rawPath.labelY + offset.y])
}
/** Read the real curve and original Worker boxes; never prescribe a layout or substitute a route. */
function detour() {
  const connections = requests.flatMap(request => request.type === 'route' ? request.connections : request.input.connections)
  for (const connection of connections) {
    const route = paths.get(connection.id)!, from = boxes.get(connection.source)!, to = boxes.get(connection.target)!
    const point = pathDetour(route, from, to)
    if (point) return { connection, route, ...point }
  }
  return undefined
}
function pathDetour(route: engine.CollaborationPath, from: engine.CollaborationLayoutBox, to: engine.CollaborationLayoutBox) {
    const points = curvePoints(route.path)
    const first = points[0]!, last = points.at(-1)!, left = Math.min(first.x, last.x), right = Math.max(first.x, last.x), top = Math.min(first.y, last.y), bottom = Math.max(first.y, last.y)
    for (let segment = 0; segment < points.length - 1; segment += 3) for (let sample = 1; sample < 100; sample++) {
      const p = points.slice(segment, segment + 4), t = sample / 100, u = 1 - t
      const x = u ** 3 * p[0]!.x + 3 * u ** 2 * t * p[1]!.x + 3 * u * t ** 2 * p[2]!.x + t ** 3 * p[3]!.x
      const y = u ** 3 * p[0]!.y + 3 * u ** 2 * t * p[1]!.y + 3 * u * t ** 2 * p[2]!.y + t ** 3 * p[3]!.y
      if ((x < left - 42 || x > right + 42 || y < top - 42 || y > bottom + 42) && !boxIntersects(from, x - 4, y - 4, 8) && !boxIntersects(to, x - 4, y - 4, 8)) return { x, y }
    }
  return undefined
}
function edgeElement(id: string) { return [...dom.container.querySelectorAll<SVGGElement>('.collaboration-connections .react-flow__edge')].find(element => element.dataset.id === id) }
function selectedRelation(scene: Scene, source: string, target: string, kind: string) {
  const from = captured.nodes.find(node => node.id === source)!.data.agent as CollaborationAgent, to = captured.nodes.find(node => node.id === target)!.data.agent as CollaborationAgent
  return scene.relations.find(relation => relation.source === from.id && relation.target === to.id && relation.kind === kind)!
}
beforeEach(() => {
  installCollaborationCanvasGeometry(600, 400); captured.store = null; captured.nodes = []; captured.cardRenders = []; select.mockReset(); open.mockReset()
  boxes = new Map(); paths = new Map(); requests = installCollaborationLayoutLoopback()
  holdResponses = false; heldResponses = []
  vi.spyOn(engine, 'handleCollaborationLayoutRequest').mockImplementation((request, publish, signal) => originalDispatch(request, response => {
    const deliver = () => {
      if (response.type === 'boxes') boxes = new Map(response.boxes.map(box => [box.id, box]))
      if (response.type === 'paths') for (const [id, path] of Object.entries(response.paths)) paths.set(id, path)
      publish(response)
    }
    if (holdResponses) heldResponses.push({ response, deliver }); else deliver()
  }, signal))
})

it('overview remount never replays a retained relationship highlight as a new reading intent', async () => {
  const scene = scenario(24); await loaded(scene)
  const id = subject('canvas-0'), node = collaborationAgentNode('area-0', id)
  await focusNode(node)
  await dom.render(graph(scene, null, scene.relations, [], scene.agents, { peeked: id }))
  const schedule = vi.spyOn(agentInformationPreview, 'schedule')
  const box = renderedBox(node)
  await viewport(-box.x * .25 + 20, -box.y * .25 + 20, 520, 300, .25)
  const mark = nodeElement(node)!.querySelector<HTMLButtonElement>('.collaboration-agent__dot')!
  expect(mark).not.toBeNull()
  expect(schedule).not.toHaveBeenCalled()
  await act(async () => mark.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })))
  expect(schedule).toHaveBeenCalledTimes(1)
  expect(requests).toHaveLength(1)
})

it('keeps the original point and actual focus through first metadata without replaying keyboard-only reading', async () => {
  const scene = scenario(24); await loaded(scene)
  const id = subject('canvas-0'), node = collaborationAgentNode('area-0', id), box = renderedBox(node)
  const unknown = new Map(scene.agents); unknown.set(id, { ...unknown.get(id)!, context: undefined })
  await dom.render(graph(scene, null, scene.relations, [], unknown))
  await viewport(-box.x * .25 + 20, -box.y * .25 + 20, 520, 300, .25)
  const point = nodeElement(node)!.querySelector<HTMLButtonElement>('.collaboration-agent__dot')!
  await act(async () => point.focus())
  expect(agentInformationPreview.getAll()).toHaveLength(0)
  await dom.render(graph(scene))
  expect(nodeElement(node)!.querySelector('.collaboration-agent__dot')).toBe(point)
  expect(document.activeElement).toBe(point)
  expect(agentInformationPreview.getAll().map(request => request.context.id)).toEqual(['canvas-0'])
  await act(async () => dom.container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.focus())
  await dom.render(graph(scene, null, scene.relations, [], unknown))
  const schedule = vi.spyOn(agentInformationPreview, 'schedule')
  await act(async () => point.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })))
  expect(schedule).not.toHaveBeenCalled()
  await dom.render(graph(scene))
  expect(schedule).toHaveBeenCalledTimes(1)
  await act(async () => point.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body })))
  await act(async () => {
    const config = useAppStore.getState().config!
    useAppStore.setState({ config: { ...config, focus: { ...config.focus, previewTrigger: 'keyboard' } } })
  })
  await dom.render(graph(scene, null, scene.relations, [], unknown))
  await act(async () => point.focus())
  await dom.render(graph(scene))
  expect(document.activeElement).toBe(point)
  expect(agentInformationPreview.getAll()).toHaveLength(0)
  await act(async () => point.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
  expect(agentInformationPreview.getAll().map(request => request.context.id)).toEqual(['canvas-0'])
})

it('the actual Graph and original xyflow mount only visible production cards from a large Worker world', async () => {
  const scene = scenario(); await loaded(scene); await focusNode(collaborationAgentNode('area-0', subject('canvas-0')))
  expect(dom.container.querySelector('.focus-context[data-session-id="canvas-0"]')).not.toBeNull()
  expect(captured.nodes).toHaveLength(484)
  expect(dom.container.querySelectorAll('.collaboration-agent').length).toBeLessThan(16)
  // Count every body ever rendered, including a transient initial full mount before library measurement.
  expect(new Set(captured.cardRenders).size).toBeGreaterThan(0); expect(new Set(captured.cardRenders).size).toBeLessThan(24)
  expect([...captured.store!.getState().nodeLookup.values()].filter(node => !node.internals.handleBounds)).toHaveLength(0)
  expect(dom.container.querySelectorAll('.react-flow__handle')).toHaveLength(0)
  expect(requests.map(request => request.type)).toEqual(['arrange'])
})

it('keeps unrelated whole node references and camera through selection and metadata-only relation updates', async () => {
  const scene = scenario(); await loaded(scene); await focusNode(collaborationAgentNode('area-0', subject('canvas-0')))
  const before = new Map(captured.nodes.map(node => [node.id, node])), camera = captured.store!.getState().transform, operations = requests.length
  await dom.render(graph(scene, { kind: 'agent', id: subject('canvas-0') }))
  expect(captured.nodes.filter(node => node !== before.get(node.id)).map(node => node.id)).toEqual([collaborationAgentNode('area-0', subject('canvas-0'))])
  const selected = new Map(captured.nodes.map(node => [node.id, node])), bodies = captured.cardRenders.length
  await dom.render(graph(scene, { kind: 'agent', id: subject('canvas-0') }, scene.relations.map(relation => ({ ...relation, evidence: [...relation.evidence] }))))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)) })
  expect(captured.nodes.every(node => node === selected.get(node.id))).toBe(true); expect(captured.cardRenders).toHaveLength(bodies)
  expect(requests).toHaveLength(operations); expect(captured.store!.getState().transform).toBe(camera)
})

it('rebuilds only one exact offscreen Agent node for metadata without another layout job or unrelated card render', async () => {
  const scene = scenario(); await loaded(scene); await focusNode(collaborationAgentNode('area-0', subject('canvas-0')))
  const [x, y] = captured.store!.getState().transform, before = new Map(captured.nodes.map(node => [node.id, node])), camera = captured.store!.getState().transform
  const distant = captured.nodes.find(node => node.type === 'agent' && !boxIntersects(boxes.get(node.id)!, -x, -y, 650))!
  expect(distant).toBeDefined()
  const original = distant.data.agent as CollaborationAgent, changed = new Map(scene.agents), bodies = captured.cardRenders.length, operations = requests.length
  changed.set(original.id, { ...original, name: 'Updated distant Session', lastActivityAt: 12345 })
  await dom.render(graph(scene, null, scene.relations, [], changed))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)) })
  expect(captured.nodes.filter(node => node !== before.get(node.id)).map(node => node.id)).toEqual([distant.id])
  expect(captured.nodes.find(node => node.id === distant.id)!.data.agent).toBe(changed.get(original.id))
  expect(captured.cardRenders).toHaveLength(bodies); expect(requests).toHaveLength(operations)
  expect(captured.store!.getState().transform).toBe(camera)
})

it('keeps every world member through viewport LOD while mounting full shared cards only at readable zoom', async () => {
  const scene = scenario(); await loaded(scene); await focusNode(collaborationAgentNode('area-0', subject('canvas-0')))
  const nodes = captured.nodes, operations = requests.length
  expect(dom.container.querySelector('.focus-context[data-session-id="canvas-0"]')).not.toBeNull()
  const focused = boxes.get(collaborationAgentNode('area-0', subject('canvas-0')))!
  await viewport(-focused.x * .25 + 20, -focused.y * .25 + 20, 600, 400, .25)
  expect(captured.nodes).toBe(nodes); expect(captured.nodes.filter(node => node.type === 'agent')).toHaveLength(480)
  expect(dom.container.querySelectorAll('.focus-context')).toHaveLength(0)
  expect(dom.container.querySelectorAll('.collaboration-agent--overview').length).toBeGreaterThan(0)
  await focusNode(collaborationAgentNode('area-0', subject('canvas-0')))
  expect(dom.container.querySelector('.focus-context[data-session-id="canvas-0"]')).not.toBeNull()
  expect(dom.container.querySelectorAll('.focus-context').length).toBeLessThan(16)
  expect(requests).toHaveLength(operations)
})

it('crossfades one visible semantic layer and keeps the original keyboard reader through continuous LOD', async () => {
  const scene = scenario(24); await loaded(scene)
  const id = collaborationAgentNode('area-0', subject('canvas-0')), box = renderedBox(id)
  const originalNodes = captured.nodes, operations = requests.length
  const scale = (zoom: number) => viewport(-box.x * zoom + 90, -box.y * zoom + 100, 600, 400, zoom)
  const semanticLayers = () => [...nodeElement(id)!.querySelectorAll<HTMLElement>('[data-map-layer]')].filter(layer => !layer.inert)
  for (const zoom of [.44, .46, .69, .71, .76, .82]) {
    await scale(zoom)
    const node = nodeElement(id)!, body = node.querySelector<HTMLElement>('.collaboration-agent__body')!
    expect(semanticLayers()).toHaveLength(1)
    expect(node.querySelectorAll('.focus-context').length).toBe(zoom > .62 ? 1 : 0)
    expect(Number.parseFloat(body.style.left) + Number.parseFloat(body.style.width) / 2).toBeCloseTo(box.width / 2)
    expect(Number.parseFloat(body.style.top) + Number.parseFloat(body.style.height) / 2).toBeCloseTo(box.height / 2)
    if (zoom === .69 || zoom === .71) {
      const detail = node.querySelector<HTMLElement>('[data-map-layer="detail"]')!
      expect(Number(detail.style.opacity)).toBeGreaterThan(0)
      expect(Number(detail.style.opacity)).toBeLessThan(1)
    }
  }
  await scale(.63)
  const identity = nodeElement(id)!.querySelector<HTMLButtonElement>('.collaboration-agent__mark')!
  await act(async () => identity.focus())
  const reader = agentInformationPreview.getAll().find(request => request.anchor === identity)!
  expect(reader).toBeDefined()
  await scale(.86)
  expect(document.activeElement).toBe(identity)
  expect(agentInformationPreview.getAll().find(request => request.token === reader.token)).toBe(reader)
  expect(semanticLayers().map(layer => layer.dataset.mapLayer)).toEqual(['identity'])
  await act(async () => { identity.blur(); agentInformationPreview.dismiss(reader.token) })
  expect(semanticLayers().map(layer => layer.dataset.mapLayer)).toEqual(['detail'])
  const card = nodeElement(id)!.querySelector<HTMLButtonElement>('.focus-context')!
  await act(async () => card.focus())
  const originalReader = agentInformationPreview.getAll().find(request => request.anchor === card)!
  expect(originalReader).toBeDefined()
  await scale(.3)
  expect(document.activeElement).toBe(card)
  expect(card.isConnected).toBe(true)
  expect(nodeElement(id)!.querySelector<HTMLElement>('[data-map-layer="detail"]')!.style.opacity).toBe('1')
  const proxy = nodeElement(id)!.querySelector<HTMLElement>('.collaboration-agent__focus-proxy')!
  expect(proxy.textContent).toContain('Agent 0')
  expect(proxy.textContent).toContain('↓ Read')
  expect(proxy.querySelector('button, [tabindex]')).toBeNull()
  expect(proxy.getAttribute('aria-hidden')).toBe('true')
  expect(agentInformationPreview.getAll().find(request => request.token === originalReader.token)).toBe(originalReader)
  expect(semanticLayers().map(layer => layer.dataset.mapLayer)).toEqual(['detail'])
  await act(async () => { card.blur(); agentInformationPreview.dismiss(originalReader.token) })
  expect(nodeElement(id)!.querySelector('.focus-context')).toBeNull()
  expect(semanticLayers().map(layer => layer.dataset.mapLayer)).toEqual(['identity'])
  expect(captured.nodes).toBe(originalNodes)
  expect(requests).toHaveLength(operations)
})

it('keeps the actual held focus proxy clear of every region label through camera movement and Reader dismissal', async () => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  let proxyRect = new DOMRect(), proxyReads = 0
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('collaboration-agent__focus-proxy')) { proxyReads++; return this.isConnected ? proxyRect : new DOMRect() }
    return originalRect.call(this)
  })
  const scene = scenario(1); scene.areas = [scene.areas[0]!]; scene.relations = []
  await loaded(scene)
  const id = collaborationAgentNode('area-0', subject('canvas-0')), box = renderedBox(id)
  const area = renderedBox(JSON.stringify(['area', 'area-0'])) as Extract<engine.CollaborationLayoutBox, { kind: 'area' }>
  const panX = 200 - (area.x + area.heading.x) * .34, panY = 204 - (area.y + area.heading.y + area.heading.height) * .34
  await viewport(panX, panY, 900, 650, .34)
  const natural = regionLabelBounds('area-0'), nodes = captured.nodes, operations = requests.length
  expect(proxyReads).toBe(0)
  expect(natural.x).toBeGreaterThan(20); expect(natural.y).toBeGreaterThan(20)
  await viewport(-box.x * .9 + 90, -box.y * .9 + 100, 900, 650, .9)
  const card = nodeElement(id)!.querySelector<HTMLButtonElement>('.focus-context')!
  await act(async () => card.focus())
  const reader = agentInformationPreview.getAll().find(request => request.anchor === card)!
  expect(reader).toBeDefined()
  // Supply the browser's measured screen footprint, not a world-size guess.
  proxyRect = new DOMRect(natural.x + 20, natural.y + 8, 120, 28)
  await viewport(panX, panY, 900, 650, .34)
  await settleCollaborationCanvas(() => expect(collaborationBoundsOverlap(regionLabelBounds('area-0'), proxyRect)).toBe(false))
  const proxy = nodeElement(id)!.querySelector<HTMLElement>('.collaboration-agent__focus-proxy')!
  expect(proxy.textContent).toContain('Agent 0'); expect(proxyReads).toBeGreaterThan(0)
  expect(document.activeElement).toBe(card)
  expect(agentInformationPreview.getAll().find(request => request.token === reader.token)).toBe(reader)
  expect(regionLabelBounds('area-0').element.querySelector('[aria-label="Locate Original area 0 · 1 Agents"]')).not.toBeNull()
  expect(regionLabelBounds('area-0').element.querySelector('[aria-label="Collapse Original area 0"]')).not.toBeNull()

  await act(async () => agentInformationPreview.dismiss(reader.token))
  expect(document.activeElement).toBe(card)
  expect(nodeElement(id)!.querySelector('.collaboration-agent__focus-proxy')).toBe(proxy)
  expect(agentInformationPreview.getAll()).toHaveLength(0)
  expect(collaborationBoundsOverlap(regionLabelBounds('area-0'), proxyRect)).toBe(false)
  // An inverse-zoom holder moves without resizing its CSS box. Camera movement
  // must replace its old screen obstacle rather than keeping a stale exclusion.
  proxyRect = new DOMRect(650, 500, 140, 28)
  await viewport(panX + 10, panY + 10, 900, 650, .34)
  await settleCollaborationCanvas(() => {
    expect(regionLabelBounds('area-0').x).toBeCloseTo(natural.x + 10, 5)
    expect(regionLabelBounds('area-0').y).toBeCloseTo(natural.y + 10, 5)
  })
  proxyRect = new DOMRect(natural.x + 31, natural.y + 19, 120, 28)
  await viewport(panX + 11, panY + 11, 900, 650, .34)
  await settleCollaborationCanvas(() => expect(collaborationBoundsOverlap(regionLabelBounds('area-0'), proxyRect)).toBe(false))
  await act(async () => card.blur())
  await settleCollaborationCanvas(() => {
    expect(nodeElement(id)!.querySelector('.collaboration-agent__focus-proxy')).toBeNull()
    expect(regionLabelBounds('area-0').x).toBeCloseTo(natural.x + 11, 5)
    expect(regionLabelBounds('area-0').y).toBeCloseTo(natural.y + 11, 5)
  })
  expect(agentInformationPreview.getAll()).toHaveLength(0)
  expect(captured.nodes).toBe(nodes); expect(requests).toHaveLength(operations)
})

it('keeps one legible identity ink through paused intermediate zoom without ghosting or avatar collisions', async () => {
  const scene = scenario(24); await loaded(scene)
  const id = collaborationAgentNode('area-0', subject('canvas-0')), box = renderedBox(id)
  const originalNodes = captured.nodes, operations = requests.length
  for (const zoom of [.319, .321, .4, .44, .46, .5, .54, .58, .62, .64, .66, .675, .68, .69, .7, .71, .72, .74, .78, .82]) {
    await viewport(-box.x * zoom + 90, -box.y * zoom + 100, 600, 400, zoom)
    const node = nodeElement(id)!, identity = node.querySelector<HTMLElement>('[data-map-layer="identity"]')!
    const detail = node.querySelector<HTMLElement>('[data-map-layer="detail"]')
    const identityOpacity = Number(identity.style.opacity), detailOpacity = detail ? Number(detail.style.opacity) : 0
    expect(identityOpacity * detailOpacity, `Two displaced text layouts must never overlap at ${zoom}`).toBe(0)
    expect([...node.querySelectorAll<HTMLElement>('[data-map-layer]')].filter(layer => !layer.inert)).toHaveLength(1)
    const title = identity.querySelector<HTMLElement>('strong')
    if (!title) continue
    const avatar = identity.querySelector<HTMLElement>('.agent-avatar')!, wrapper = identity.querySelector<HTMLElement>('.collaboration-agent__avatar')!
    const center = Number.parseFloat(node.querySelector<HTMLElement>('.collaboration-agent')!.style.getPropertyValue('--collaboration-avatar-center'))
    const radius = Number.parseFloat(avatar.style.getPropertyValue('--agent-avatar-size')) / 2 * Number.parseFloat(wrapper.style.getPropertyValue('--collaboration-avatar-scale'))
    const titleLeft = Number.parseFloat(title.style.left)
    if (Number(title.style.opacity) * identityOpacity > 0) {
      expect(titleLeft - center - radius, `Name starts after the actual avatar at ${zoom}`).toBeGreaterThanOrEqual(7.9999)
      expect(Number.parseFloat(title.style.fontSize) * zoom).toBeGreaterThanOrEqual(10.9999)
    }
    if (zoom === .44 || zoom === .46) expect(Number(title.style.opacity)).toBe(0)
    if (zoom === .54 || zoom === .58) expect(Number(title.style.opacity)).toBeGreaterThan(0)
    if (zoom === .72) { expect(identityOpacity).toBe(0); expect(detailOpacity).toBeGreaterThan(0) }
  }
  expect(captured.nodes).toBe(originalNodes)
  expect(requests).toHaveLength(operations)
})

it('keeps one continuous body ring when the original avatar button crosses the overview identity boundary', async () => {
  const stylesheet = document.createElement('style'); stylesheet.textContent = collaborationCSS; document.head.append(stylesheet)
  try {
    const scene = scenario(1); scene.relations = []
    await loaded(scene)
    const id = collaborationAgentNode('area-0', subject('canvas-0')), box = renderedBox(id), operations = requests.length
    let body: HTMLElement | null = null, button: HTMLButtonElement | null = null
    const progress: number[] = []
    for (const zoom of [.319, .321, .4, .5, .58]) {
      await viewport(-box.x * zoom + 90, -box.y * zoom + 100, 600, 400, zoom)
      const agent = nodeElement(id)!.querySelector<HTMLElement>('.collaboration-agent')!
      const currentBody = agent.querySelector<HTMLElement>('.collaboration-agent__body')!
      const currentButton = agent.querySelector<HTMLButtonElement>('.collaboration-agent__dot, .collaboration-agent__mark')!
      if (body) { expect(currentBody).toBe(body); expect(currentButton).toBe(button) }
      body = currentBody; button = currentButton
      expect(button.classList.contains('collaboration-agent__dot')).toBe(zoom === .319)
      // The real class handoff cannot acquire/remove its own second ring.
      expect(['', 'none']).toContain(getComputedStyle(button).boxShadow)
      expect(getComputedStyle(button).borderTopWidth).toBe('0px')
      expect(getComputedStyle(body).boxShadow).toContain('inset')
      expect(getComputedStyle(agent).getPropertyValue('--collaboration-body-line')).toContain('var(--collaboration-identity, 1)')
      progress.push(Number(agent.style.getPropertyValue('--collaboration-identity')))
    }
    expect(progress[0]).toBe(0); expect(progress[1]).toBeGreaterThan(0); expect(progress[1]).toBeLessThan(.001)
    expect(progress.at(-1)).toBe(1)
    expect(requests).toHaveLength(operations)
  } finally { stylesheet.remove() }
})

it('passes the effective Motion preference to explicit camera intent and cancels only an active transition', async () => {
  const scene = scenario(24); await loaded(scene)
  let config = useAppStore.getState().config!
  vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => {
    config = applyConfigEdit(config, expected, next); useAppStore.setState({ config }); return config
  })
  const panZoom = captured.store!.getState().panZoom!
  let finish: ((value: boolean) => void) | undefined
  // Keep the real camera boundary pending; HappyDOM does not implement D3's
  // screen transform interpolation. The production caller must still cancel it.
  const scaleBy = vi.spyOn(panZoom, 'scaleBy').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const setViewport = vi.spyOn(panZoom, 'setViewport')
  await dom.click('[aria-label="Zoom in"]')
  expect(scaleBy.mock.calls.at(-1)?.[1]).toMatchObject({ duration: 280 })
  await dom.click('[aria-label="Map animations"]')
  expect(setViewport.mock.calls.at(-1)?.[1]).toMatchObject({ duration: 0 })
  await act(async () => finish?.(true))
  scaleBy.mockResolvedValue(true)
  await dom.click('[aria-label="Zoom out"]')
  expect(scaleBy.mock.calls.at(-1)?.[1]).toMatchObject({ duration: 0 })
  const camera = captured.store!.getState().transform
  await dom.click('[aria-label="Map animations"]')
  expect(captured.store!.getState().transform).toBe(camera)
  await dom.render(graph(scene, null, scene.relations, [], scene.agents, { active: false }))
  expect(dom.container.querySelector('.collaboration-canvas')?.getAttribute('data-motion')).toBe('off')
})

it('joins the drawn hull of every Agent tier through LOD and keeps glyph geometry unchanged by selection', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
  const scene = scenario(5), tiers = ['active', 'idle', 'unknown', 'closed', 'unknown'] as const
  scene.agents = new Map<string, CollaborationAgent>([...scene.agents].map(([id, agent], index) => {
    const { providerId: _providerId, ...withoutProvider } = agent
    return [id, { ...(index === 4 ? { ...withoutProvider, context: { ...agent.context!, providerId: null } } : agent), tier: tiers[index]!, lastActivityAt: 999_000 }]
  }))
  scene.areas = [{ id: 'tiers', name: 'All original tiers', kind: 'project', members: [...scene.agents.keys()] }]
  scene.relations = [...scene.agents.keys()].slice(1).map((target, index) => ({ id: `tier-${index}`, kind: 'communication', source: [...scene.agents.keys()][0]!, target, evidence: [] }))
  await loaded(scene)
  const originalNodes = captured.nodes, operations = requests.length
  const endpointDistance = (point: { x: number; y: number }, id: string) => {
    const box = renderedBox(id), body = nodeElement(id)!.querySelector<HTMLElement>('.collaboration-agent__body')!
    const width = Number.parseFloat(body.style.width), height = Number.parseFloat(body.style.height), radius = Number.parseFloat(body.style.borderRadius)
    const x = Math.abs(point.x - box.x - Number.parseFloat(body.style.left) - width / 2) - width / 2 + radius
    const y = Math.abs(point.y - box.y - Number.parseFloat(body.style.top) - height / 2) - height / 2 + radius
    return Math.hypot(Math.max(x, 0), Math.max(y, 0)) + Math.min(Math.max(x, y), 0) - radius
  }
  let previousGlyphs: { avatar: boolean; point: number }[] | undefined
  for (const zoom of [.319, .321, .44, .46, .69, .71, .9]) {
    await viewport(60, 60, 4000, 4000, zoom)
    const glyphs = captured.nodes.filter(node => node.type === 'agent').map(node => {
      const element = nodeElement(node.id)!
      return { avatar: Boolean(element.querySelector('.agent-avatar')), point: Number.parseFloat(element.querySelector<HTMLElement>('.collaboration-agent__point')!.style.width) }
    })
    expect(glyphs.map(glyph => glyph.avatar)).toEqual([true, true, true, false, false])
    if (zoom === .319) for (const node of captured.nodes.filter(node => node.type === 'agent')) {
      const element = nodeElement(node.id)!, dot = element.querySelector<HTMLElement>('.collaboration-agent__dot')!
      const body = element.querySelector<HTMLElement>('.collaboration-agent__body')!
      const visibleDiameter = element.querySelector('.agent-avatar') ? Number.parseFloat(dot.style.width)
        : Number.parseFloat(element.querySelector<HTMLElement>('.collaboration-agent__point')!.style.width)
      expect(Number.parseFloat(body.style.width)).toBeCloseTo(visibleDiameter * Number.parseFloat(element.querySelector<HTMLElement>('.collaboration-agent')!.style.getPropertyValue('--collaboration-mark-scale')))
    }
    if (zoom === .321) {
      expect(glyphs.map(glyph => glyph.avatar)).toEqual(previousGlyphs!.map(glyph => glyph.avatar))
      expect(Math.abs(glyphs[3]!.point - previousGlyphs![3]!.point)).toBeLessThan(.01)
    }
    previousGlyphs = glyphs
    for (const edge of dom.container.querySelectorAll<SVGGElement>('.collaboration-connections .react-flow__edge')) {
      const connection = requests.flatMap(request => request.type === 'arrange' ? request.input.connections : []).find(connection => connection.id === edge.dataset.id)!
      const points = curvePoints(edge.querySelector('.react-flow__edge-path')!.getAttribute('d')!)
      expect(Math.abs(endpointDistance(points[0]!, connection.source))).toBeLessThan(1e-4)
      expect(Math.abs(endpointDistance(points.at(-1)!, connection.target))).toBeLessThan(1e-4)
    }
    const curves = [...dom.container.querySelectorAll('.react-flow__edge-path')].map(path => path.getAttribute('d'))
    await dom.render(graph(scene, { kind: 'agent', id: subject('canvas-3') }))
    expect([...dom.container.querySelectorAll('.react-flow__edge-path')].map(path => path.getAttribute('d'))).toEqual(curves)
    await dom.render(graph(scene))
  }
  expect(captured.nodes.map(node => node.data.box)).toEqual(originalNodes.map(node => node.data.box))
  expect(requests).toHaveLength(operations)
})

it('renders and selects an actual Worker detour while both original endpoint cards are offscreen', async () => {
  const scene = await loadedDetourScene()
  const candidate = detour(); expect(candidate, 'The actual force scene must contain a curve outside the endpoint rectangle').toBeDefined()
  const { connection, route, x, y } = candidate!
  await viewport(-x + 4, -y + 4, 8, 8)
  for (const id of [connection.source, connection.target]) expect([...dom.container.querySelectorAll('.react-flow__node')].some(element => element.getAttribute('data-id') === id)).toBe(false)
  const edge = edgeElement(connection.id); expect(edge).toBeDefined()
  expectAnchoredVisibleCurve(route, curvePoints(edge!.querySelector('.react-flow__edge-path')!.getAttribute('d')!), { x: 0, y: 0 })
  expect(edge!.querySelector('.react-flow__edge-interaction')?.getAttribute('stroke-width')).toBe('22')
  const marker = /^url\(#(.+)\)$/.exec(edge!.querySelector('.react-flow__edge-path')!.getAttribute('marker-end')!)
  expect(marker).not.toBeNull(); expect(document.getElementById(marker![1]!)?.localName).toBe('marker')
  expect(edge!.getAttribute('role')).toBe('button'); expect(edge!.getAttribute('tabindex')).toBe('0')
  const relation = selectedRelation(scene, connection.source, connection.target, connection.kind), expected = { kind: 'relation', id: relation.id, relatedIds: [relation.id] }
  await act(async () => edge!.querySelector('.react-flow__edge-interaction')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(select).toHaveBeenLastCalledWith(expected)
  for (const key of ['Enter', ' ']) {
    select.mockClear(); const input = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    await act(async () => edge!.dispatchEvent(input))
    expect(input.defaultPrevented).toBe(true); expect(select).toHaveBeenCalledTimes(1); expect(select).toHaveBeenLastCalledWith(expected)
  }
  select.mockClear(); await act(async () => edge!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(select).toHaveBeenCalledTimes(1); expect(select).toHaveBeenLastCalledWith(null); expect(open).not.toHaveBeenCalled()
})

it('keeps an original pulse phase through selection and resumes only its elapsed phase after viewport remount', async () => {
  const scene = await loadedDetourScene()
  const candidate = detour(); expect(candidate).toBeDefined()
  const { connection, x, y } = candidate!, relation = selectedRelation(scene, connection.source, connection.target, connection.kind)
  expect(relation.kind).not.toBe('creation')
  if (relation.kind === 'creation') throw Error('The original activity stream does not emit creation pulses')
  await viewport(-x + 4, -y + 4, 8, 8)
  const clock = vi.spyOn(Date, 'now').mockReturnValue(10000)
  const from = scene.agents.get(relation.source)!, to = scene.agents.get(relation.target)!
  const pulses: CollaborationPulse[] = [{ id: 1, startedAt: 9600, hostId: 'local', sender: from.sessionId!, recipient: to.sessionId!, kind: relation.kind }]
  await dom.render(graph(scene, null, scene.relations, pulses))
  const pulse = edgeElement(connection.id)!.querySelector<SVGPathElement>('.collaboration-edge__pulse')!
  expect(pulse).not.toBeNull(); expect(pulse.style.animationDelay).toBe('-400ms')
  clock.mockReturnValue(10300); await dom.render(graph(scene, { kind: 'relation', id: relation.id }, scene.relations, pulses))
  expect(edgeElement(connection.id)!.querySelector('.collaboration-edge__pulse')).toBe(pulse); expect(pulse.style.animationDelay).toBe('-400ms')
  await viewport(-100000, -100000, 8, 8); expect(dom.container.querySelector('.collaboration-edge__pulse')).toBeNull()
  clock.mockReturnValue(10700); await viewport(-x + 4, -y + 4, 8, 8)
  const resumed = edgeElement(connection.id)!.querySelector<SVGPathElement>('.collaboration-edge__pulse')!
  expect(resumed).not.toBeNull(); expect(resumed).not.toBe(pulse); expect(resumed.style.animationDelay).toBe('-1100ms')
  const operations = requests.length
  await dom.render(graph(scene, null, scene.relations, []))
  expect(dom.container.querySelector('.collaboration-edge__pulse')).toBeNull(); expect(requests).toHaveLength(operations)
})

it('locates a member inside a folded area once and preserves a later user fold through metadata changes', async () => {
  const scene = scenario(24); await loaded(scene)
  const areaId = JSON.stringify(['area', 'area-0']), agentId = collaborationAgentNode('area-0', subject('canvas-0'))
  async function fold() {
    const area = boxes.get(areaId)!
    await viewport(-area.x + 12, -area.y + 12)
    const node = [...dom.container.querySelectorAll('.react-flow__node')].find(element => element.getAttribute('data-id') === areaId)
    expect(node).toBeDefined()
    const heading = dom.container.querySelector<HTMLButtonElement>(`[data-area-id='${areaId}'] .collaboration-area__fold`)!
    expect(heading.getAttribute('aria-expanded')).toBe('true')
    await act(async () => heading.click())
    await settleCollaborationCanvas(() => {
      expect(boxes.get(areaId)?.folded).toBe(true)
      expect(captured.nodes.some(node => node.id === agentId)).toBe(false)
      expect(dom.container.querySelector('.collaboration-canvas__progress')).toBeNull()
    })
  }
  await fold()
  const locate = { token: {}, agentId: subject('canvas-0') }
  await dom.render(graph(scene, null, scene.relations, [], scene.agents, { ready: true, locate }))
  await settleCollaborationCanvas(() => {
    const box = boxes.get(agentId); expect(box).toBeDefined(); expect(boxes.get(areaId)?.folded).toBe(false)
    const { transform: [x, y, zoom], width, height } = captured.store!.getState()
    expect((box!.x + box!.width / 2) * zoom + x).toBeCloseTo(width / 2, 4)
    expect((box!.y + box!.height / 2) * zoom + y).toBeCloseTo(height / 2, 4)
    expect(dom.container.querySelector('.focus-context[data-session-id="canvas-0"]')).not.toBeNull()
  })
  await fold()
  const operations = requests.length, camera = captured.store!.getState().transform
  const renamed = { ...scene, areas: scene.areas.map(area => ({ ...area, name: `${area.name} renamed` })) }
  await dom.render(graph(renamed, null, renamed.relations, [], renamed.agents, { ready: true, locate }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)) })
  expect(boxes.get(areaId)?.folded).toBe(true); expect(captured.nodes.some(node => node.id === agentId)).toBe(false)
  expect(requests).toHaveLength(operations); expect(captured.store!.getState().transform).toBe(camera)
})

it('honors the original manual camera gesture before a delayed locate frame applies', async () => {
  const scene = scenario(24); await loaded(scene)
  const frames = new Map<number, FrameRequestCallback>(); let sequence = 0
  const frameSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++sequence, callback); return sequence })
  const cancelSpy = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id) })
  try {
    await dom.render(graph(scene, null, scene.relations, [], scene.agents, { ready: true, locate: { token: {}, agentId: subject('canvas-0') } }))
    expect(frames.size).toBeGreaterThan(0); expect(captured.moveStart).toBeDefined()
    // This is the real ReactFlow callback boundary. Native physical panning is covered separately.
    await act(async () => { captured.moveStart!(new MouseEvent('mousedown'), { x: -321, y: -654, zoom: 1 }) })
    await viewport(-321, -654)
    await act(async () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(performance.now()) })
    expect(captured.store!.getState().transform).toEqual([-321, -654, 1])
  } finally { frameSpy.mockRestore(); cancelSpy.mockRestore() }
})

it('keeps explicit Zoom and Fit intent when original Worker placement arrives after the button click', async () => {
  const scene = scenario(24)
  for (const control of ['Zoom in', 'Zoom out', 'Overview']) {
    holdResponses = true; heldResponses = []
    await dom.render(<AgentCollaborationGraph key={control} agents={scene.agents} areas={scene.areas} relations={scene.relations} pulses={[]} selection={null} onSelect={select} onOpen={open}
      ready locate={{ token: {}, agentId: subject('canvas-0') }} />)
    await settleCollaborationCanvas(() => expect(heldResponses.some(item => item.response.type === 'complete')).toBe(true))
    expect(captured.nodes).toHaveLength(0)
    const button = [...dom.container.querySelectorAll<HTMLButtonElement>('.collaboration-canvas__controls button')].find(button => button.getAttribute('aria-label') === control)
    expect(button).toBeDefined()
    await act(async () => { button!.click(); await new Promise(resolve => setTimeout(resolve, 20)) })
    const camera = [...captured.store!.getState().transform]
    await act(async () => { holdResponses = false; const pending = heldResponses; heldResponses = []; for (const item of pending) item.deliver() })
    await settleCollaborationCanvas(() => {
      expect(captured.nodes).toHaveLength(28)
      expect(dom.container.querySelector('.collaboration-canvas__progress')).toBeNull()
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
    const current = captured.store!.getState().transform
    if (control === 'Overview') {
      // The original fitView intentionally waits for node measurement; verify its deferred full-world intent.
      expect(current[2]).toBeLessThan(1)
      const { width, height } = captured.store!.getState()
      for (const box of boxes.values()) {
        expect(box.x * current[2] + current[0]).toBeGreaterThanOrEqual(-1e-6)
        expect(box.y * current[2] + current[1]).toBeGreaterThanOrEqual(-1e-6)
        expect((box.x + box.width) * current[2] + current[0]).toBeLessThanOrEqual(width + 1e-6)
        expect((box.y + box.height) * current[2] + current[1]).toBeLessThanOrEqual(height + 1e-6)
      }
    } else expect(current, control).toEqual(camera)
    const target = boxes.get(collaborationAgentNode('area-0', subject('canvas-0')))!, { width, height } = captured.store!.getState()
    // The retained camera must differ from the late Locate; equal incidental views cannot qualify cancellation.
    expect(current[2] !== 1 || Math.abs((target.x + target.width / 2) * current[2] + current[0] - width / 2) > 1 || Math.abs((target.y + target.height / 2) * current[2] + current[1] - height / 2) > 1).toBe(true)
  }
})

it('keeps unrelated occurrences and paths stable through an actual activity size transition', async () => {
  const original = scenario(24), shared = subject('canvas-0')
  const scene = { ...original, areas: original.areas.map((area, index) => index === 3 ? { ...area, members: [...area.members, shared] } : area) }
  await loaded(scene)
  const first = collaborationAgentNode('area-0', shared), reading = collaborationAgentNode('area-3', shared)
  await focusNode(reading)
  const body = nodeElement(reading)!.querySelector<HTMLButtonElement>('.focus-context')!
  expect(body).not.toBeNull(); await act(async () => body.click())
  expect(select).toHaveBeenLastCalledWith({ kind: 'agent', id: shared })
  const previous = new Map(captured.nodes.map(node => [node.id, node.data.box as engine.CollaborationLayoutBox])), camera = captured.store!.getState().transform
  const changed = new Map(scene.agents); changed.set(subject('canvas-7'), { ...changed.get(subject('canvas-7'))!, tier: 'idle' })
  holdResponses = true
  await dom.render(graph(scene, null, scene.relations, [], changed))
  await settleCollaborationCanvas(() => expect(heldResponses.some(item => item.response.type === 'complete')).toBe(true))
  expect(renderedBox(reading)).toBe(previous.get(reading)); expect(nodeElement(reading)!.querySelector('.focus-context')).toBe(body)
  const raw = heldResponses.find(item => item.response.type === 'boxes')!.response
  expect(raw.type).toBe('boxes'); if (raw.type !== 'boxes') throw Error('Actual Worker boxes required')
  const placed = new Map(raw.boxes.map(box => [box.id, box])), offset = { x: previous.get(reading)!.x - placed.get(reading)!.x, y: previous.get(reading)!.y - placed.get(reading)!.y }
  expect(offset).toEqual({ x: 0, y: 0 })
  expect(placed.get(first)).toEqual(previous.get(first))
  expect(requests.map(request => request.type)).toEqual(['arrange', 'reconcile'])
  for (const [id, before] of previous) if (before.kind === 'agent' && id !== collaborationAgentNode('area-3', subject('canvas-7'))) expect(placed.get(id)).toEqual(before)
  await releasePlacement()
  expect(renderedBox(reading).x).toBeCloseTo(previous.get(reading)!.x, 8); expect(renderedBox(reading).y).toBeCloseTo(previous.get(reading)!.y, 8)
  expect(nodeElement(reading)!.querySelector('.focus-context')).toBe(body); expect(captured.store!.getState().transform).toBe(camera)
  expect(requests).toHaveLength(2)
  for (const node of captured.nodes) {
    const actual = renderedBox(node.id), input = placed.get(node.id)!
    expect(actual.x).toBeCloseTo(input.x + offset.x, 8); expect(actual.y).toBeCloseTo(input.y + offset.y, 8)
  }
  const world = [...captured.nodes].map(node => renderedBox(node.id)), left = Math.min(...world.map(box => box.x)), top = Math.min(...world.map(box => box.y))
  await viewport(-left * .1 + 20, -top * .1 + 20, 2000, 2000, .1)
  const overviewEdges = [...dom.container.querySelectorAll<SVGGElement>('.collaboration-connections .react-flow__edge')]
  expect(overviewEdges.length).toBeGreaterThan(0)
  await viewport(-left + 20, -top + 20, 20000, 20000, 1)
  const edges = [...new Map([...overviewEdges, ...dom.container.querySelectorAll<SVGGElement>('.collaboration-connections .react-flow__edge')].map(edge => [edge.dataset.id, edge])).values()]
  expect(edges).toHaveLength(paths.size)
  for (const edge of edges) {
    const rawPath = paths.get(edge.dataset.id!)!, curve = curvePoints(edge.querySelector('.react-flow__edge-path')!.getAttribute('d')!)
    expectAnchoredVisibleCurve(rawPath, curve, offset)
  }
})

it('keeps keyboard reading anchored then honors the last actual pointer during a later size job without another request', async () => {
  const scene = scenario(24); await loaded(scene)
  const preview = vi.fn()
  await dom.render(graph(scene, null, scene.relations, [], scene.agents, { onPreviewAgent: preview }))
  const earlier = collaborationAgentNode('area-0', subject('canvas-0')), reading = collaborationAgentNode('area-1', subject('canvas-1'))
  await focusNode(earlier)
  const body = nodeElement(earlier)!.querySelector<HTMLButtonElement>('.focus-context')!, firstBox = renderedBox(earlier), firstCamera = captured.store!.getState().transform
  await act(async () => { body.focus(); body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  expect(select).not.toHaveBeenCalled()
  expect(preview).toHaveBeenLastCalledWith(subject('canvas-0'))
  await act(async () => dom.container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.focus())
  expect(preview).toHaveBeenLastCalledWith(null)
  const changed = new Map(scene.agents); changed.set(subject('canvas-4'), { ...changed.get(subject('canvas-4'))!, tier: 'idle' })
  holdResponses = true; await dom.render(graph(scene, null, scene.relations, [], changed))
  await settleCollaborationCanvas(() => expect(heldResponses.some(item => item.response.type === 'complete')).toBe(true))
  await releasePlacement()
  expect([renderedBox(earlier).x, renderedBox(earlier).y]).toEqual([firstBox.x, firstBox.y])
  expect(nodeElement(earlier)!.querySelector('.focus-context')).toBe(body); expect(captured.store!.getState().transform).toBe(firstCamera)
  const previous = new Map(captured.nodes.map(node => [node.id, node.data.box as engine.CollaborationLayoutBox]))
  const next = new Map(scene.agents)
  holdResponses = true; await dom.render(graph(scene, null, scene.relations, [], next))
  await settleCollaborationCanvas(() => expect(heldResponses.some(item => item.response.type === 'complete')).toBe(true))
  await pointAt(reading)
  const camera = captured.store!.getState().transform
  await releasePlacement()
  expect(renderedBox(reading).x).toBeCloseTo(previous.get(reading)!.x, 8); expect(renderedBox(reading).y).toBeCloseTo(previous.get(reading)!.y, 8)
  expect(captured.store!.getState().transform).toBe(camera); expect(requests.map(request => request.type)).toEqual(['arrange', 'reconcile', 'reconcile'])
})

it('preserves the clicked area heading through folding and unfolding without resurrecting the prior Agent anchor', async () => {
  const original = scenario(24), scene = { ...original, areas: original.areas.map((area, index) => index === 3 ? { ...area, members: [...area.members, subject('canvas-0')] } : area) }
  await loaded(scene)
  const reading = collaborationAgentNode('area-0', subject('canvas-0')), areaId = JSON.stringify(['area', 'area-0']), locate = { token: {}, agentId: subject('canvas-0') }
  await dom.render(graph(scene, null, scene.relations, [], scene.agents, { ready: true, locate }))
  await settleCollaborationCanvas(() => {
    const box = renderedBox(reading), { transform: [x, y, zoom], width, height } = captured.store!.getState()
    expect((box.x + box.width / 2) * zoom + x).toBeCloseTo(width / 2, 4); expect((box.y + box.height / 2) * zoom + y).toBeCloseTo(height / 2, 4)
  })
  const previous = renderedBox(reading), changed = new Map(scene.agents)
  changed.set(subject('canvas-4'), { ...changed.get(subject('canvas-4'))!, tier: 'idle' })
  await dom.render(graph(scene, null, scene.relations, [], changed, { ready: true, locate }))
  await settleCollaborationCanvas(() => { expect(requests).toHaveLength(2); expect(dom.container.querySelector('.collaboration-canvas__progress')).toBeNull() })
  expect([renderedBox(reading).x, renderedBox(reading).y]).toEqual([previous.x, previous.y])
  const headingAt = () => { const box = renderedBox(areaId) as Extract<engine.CollaborationLayoutBox, { kind: 'area' }>; return { x: box.x + box.heading.x, y: box.y + box.heading.y } }
  const heading = headingAt(); await viewport(-heading.x + 12, -heading.y + 12)
  const camera = captured.store!.getState().transform
  const clicked = regionLabelBounds('area-0')
  holdResponses = true
  await act(async () => dom.container.querySelector<HTMLButtonElement>(`[data-area-id='${areaId}'] .collaboration-area__fold`)!.click())
  await settleCollaborationCanvas(() => expect(heldResponses.some(item => item.response.type === 'complete')).toBe(true))
  await releasePlacement()
  expect(captured.nodes.some(node => node.id === reading)).toBe(false)
  expect(headingAt().x).toBeCloseTo(heading.x, 8); expect(headingAt().y).toBeCloseTo(heading.y, 8)
  expect(captured.store!.getState().transform[2]).toBe(camera[2])
  const collapsedLabel = regionLabelBounds('area-0')
  expect(collapsedLabel.x).toBeCloseTo(clicked.x, 6)
  expect(collapsedLabel.y + collapsedLabel.height).toBeCloseTo(clicked.y + clicked.height, 6)
  expect(dom.container.querySelector(`[data-area-id='${areaId}'] .collaboration-area__fold`)).not.toBeNull()
  await act(async () => dom.container.querySelector<HTMLButtonElement>(`[data-area-id='${areaId}'] .collaboration-area__fold`)!.click())
  await settleCollaborationCanvas(() => { expect(captured.nodes.some(node => node.id === reading)).toBe(true); expect(dom.container.querySelector('.collaboration-canvas__progress')).toBeNull() })
  const expandedCamera = captured.store!.getState().transform
  const resized = new Map(changed); resized.set(subject('canvas-8'), { ...resized.get(subject('canvas-8'))!, tier: 'closed' })
  await dom.render(graph(scene, null, scene.relations, [], resized, { ready: true, locate }))
  await settleCollaborationCanvas(() => { expect(requests).toHaveLength(5); expect(dom.container.querySelector('.collaboration-canvas__progress')).toBeNull() })
  // The explicitly read heading remains the anchor; a reappearing Agent is not a new reading intent.
  expect(headingAt().x).toBeCloseTo(heading.x, 8); expect(headingAt().y).toBeCloseTo(heading.y, 8)
  expect(captured.store!.getState().transform).toBe(expandedCamera)
})

function regionLabelBounds(id: string) {
  const label = dom.container.querySelector<HTMLElement>(`[data-region-id="${id}"]`)!
  expect(label).not.toBeNull()
  return { element: label, x: Number.parseFloat(label.style.left), y: Number.parseFloat(label.style.top), width: Number(label.dataset.labelWidth), height: Number(label.dataset.labelHeight) }
}
async function readDistantRegion(scene: Scene) {
  const area = renderedBox(JSON.stringify(['area', 'area-0'])) as Extract<engine.CollaborationLayoutBox, { kind: 'area' }>
  const member = scene.areas[0]!.members.map(id => renderedBox(collaborationAgentNode('area-0', id))).sort((a, b) => b.y - a.y)[0]!
  await viewport(-member.x + 20, -member.y + 90, 600, 400)
  const label = regionLabelBounds('area-0'), [x, y, zoom] = captured.store!.getState().transform
  expect((area.y + area.heading.y + area.heading.height) * zoom + y).toBeLessThan(0)
  expect(label.element.dataset.context).toBe('true')
  expect(label.x).toBeGreaterThanOrEqual(0); expect(label.y).toBeGreaterThanOrEqual(0)
  expect(label.x + label.width).toBeLessThanOrEqual(600); expect(label.y + label.height).toBeLessThanOrEqual(400)
  return { area, label, camera: [x, y, zoom] }
}

it('keeps a clamped region label and its Expand action visible after the original world heading folds offscreen', async () => {
  const scene = scenario(24); await loaded(scene)
  const { area, label, camera } = await readDistantRegion(scene)
  holdResponses = true
  await act(async () => label.element.querySelector<HTMLButtonElement>('.collaboration-area__fold')!.click())
  await settleCollaborationCanvas(() => expect(heldResponses.some(item => item.response.type === 'complete')).toBe(true))
  expect(captured.store!.getState().transform).toEqual(camera)
  await releasePlacement()
  const folded = renderedBox(area.id) as Extract<engine.CollaborationLayoutBox, { kind: 'area' }>
  expect(folded.folded).toBe(true)
  const [x, y, zoom] = captured.store!.getState().transform
  expect(zoom).toBe(camera[2])
  expect((folded.x + folded.heading.x) * zoom + x).toBeCloseTo(label.x, 6)
  expect((folded.y + folded.heading.y + folded.heading.height) * zoom + y).toBeCloseTo(label.y + label.height, 6)
  const visible = regionLabelBounds('area-0'), expand = visible.element.querySelector<HTMLButtonElement>('[aria-label="Expand Original area 0"]')!
  expect(expand).not.toBeNull()
  expect(visible.x).toBeGreaterThanOrEqual(0); expect(visible.y).toBeGreaterThanOrEqual(0)
  expect(visible.x + visible.width).toBeLessThanOrEqual(600); expect(visible.y + visible.height).toBeLessThanOrEqual(400)
  await act(async () => expand.click())
  await settleCollaborationCanvas(() => { expect(renderedBox(area.id).folded).toBe(false); expect(dom.container.querySelector('.collaboration-canvas__progress')).toBeNull() })
  expect(regionLabelBounds('area-0').element.querySelector('[aria-label="Collapse Original area 0"]')).not.toBeNull()
  expect(captured.store!.getState().transform[2]).toBe(camera[2])
})

it('keeps a natural nested heading and its Expand action at the actual clicked screen position', async () => {
  const scene = scenario(12), members = [...scene.agents.keys()]
  scene.areas = [{ id: 'root', name: 'Original project', kind: 'project', members: [] },
    { id: 'nested', name: 'Collaboration terrain', kind: 'project', parentId: 'root', members: [] },
    { id: 'messages', name: 'Message tools', kind: 'project', parentId: 'nested', members: members.slice(0, 6) },
    { id: 'rendering', name: 'Rendering', kind: 'project', parentId: 'nested', members: members.slice(6) }]
  await loaded(scene)
  const id = JSON.stringify(['area', 'nested']), original = renderedBox(id) as Extract<engine.CollaborationLayoutBox, { kind: 'area' }>
  const zoom = .85
  await viewport(100 - (original.x + original.heading.x) * zoom, 100 - (original.y + original.heading.y) * zoom, 900, 600, zoom)
  const before = regionLabelBounds('nested')
  expect(before.element.dataset.context).toBeUndefined()
  expect(before.x).toBeGreaterThanOrEqual(0); expect(before.y).toBeGreaterThanOrEqual(0)
  expect(before.element.querySelector('[aria-label="Collapse Collaboration terrain"]')).not.toBeNull()
  holdResponses = true
  await act(async () => before.element.querySelector<HTMLButtonElement>('.collaboration-area__fold')!.click())
  await settleCollaborationCanvas(() => expect(heldResponses.some(item => item.response.type === 'complete')).toBe(true))
  await releasePlacement()
  const folded = renderedBox(id) as Extract<engine.CollaborationLayoutBox, { kind: 'area' }>
  expect(folded.folded).toBe(true)
  expect(captured.nodes.some(node => node.type === 'agent')).toBe(false)
  const after = regionLabelBounds('nested'), expand = after.element.querySelector<HTMLButtonElement>('[aria-label="Expand Collaboration terrain"]')!
  expect(expand).not.toBeNull()
  expect(after.x).toBeCloseTo(before.x, 5)
  expect(after.y + after.height).toBeCloseTo(before.y + before.height, 5)
  expect(captured.store!.getState().transform[2]).toBe(zoom)
  await act(async () => expand.click())
  await settleCollaborationCanvas(() => { expect(renderedBox(id).folded).toBe(false); expect(captured.nodes.filter(node => node.type === 'agent')).toHaveLength(12) })
  const restored = regionLabelBounds('nested')
  expect(restored.element.querySelector('[aria-label="Collapse Collaboration terrain"]')).not.toBeNull()
  expect(restored.x).toBeCloseTo(before.x, 5)
  expect(restored.y + restored.height).toBeCloseTo(before.y + before.height, 5)
  expect(captured.store!.getState().transform[2]).toBe(zoom)
})

it('retains the original empty subtree and its Expand action while its children are folded away', async () => {
  const scene = scenario(0); scene.relations = []
  scene.areas = [{ id: 'empty-parent', name: 'Original empty parent', kind: 'project', members: [] },
    { id: 'empty-child', name: 'Original empty child', kind: 'topic', parentId: 'empty-parent', members: [] }]
  await loaded(scene)
  const parentId = JSON.stringify(['area', 'empty-parent']), childId = JSON.stringify(['area', 'empty-child'])
  const parent = renderedBox(parentId) as Extract<engine.CollaborationLayoutBox, { kind: 'area' }>
  await viewport(100 - parent.x - parent.heading.x, 100 - parent.y - parent.heading.y, 700, 400)
  const original = regionLabelBounds('empty-parent')
  expect(original.element.textContent).toContain('0 Agents incl. subspaces')
  expect(original.element.dataset.empty).toBeUndefined()
  const collapse = original.element.querySelector<HTMLButtonElement>('[aria-label="Collapse Original empty parent"]')!
  expect(collapse).not.toBeNull()
  await act(async () => collapse.click())
  await settleCollaborationCanvas(() => { expect(renderedBox(parentId).folded).toBe(true); expect(captured.nodes).toHaveLength(1) })
  expect(captured.nodes.some(node => node.id === childId)).toBe(false)
  const folded = regionLabelBounds('empty-parent')
  expect(folded.element.textContent).toContain('0 Agents incl. subspaces')
  expect(captured.nodes[0]!.data.childCount).toBe(1)
  const expand = folded.element.querySelector<HTMLButtonElement>('[aria-label="Expand Original empty parent"]')!
  expect(expand).not.toBeNull()
  await act(async () => expand.click())
  await settleCollaborationCanvas(() => { expect(renderedBox(parentId).folded).toBe(false); expect(captured.nodes).toHaveLength(2) })
  expect(captured.nodes.some(node => node.id === childId)).toBe(true)
  expect(regionLabelBounds('empty-parent').element.querySelector('[aria-label="Collapse Original empty parent"]')).not.toBeNull()
  expect(captured.nodes.some(node => node.type === 'agent')).toBe(false)
})

it.each(['pan', 'locate'] as const)('a newer %s cancels the pending screen anchor of an earlier region fold', async intent => {
  const scene = scenario(24); await loaded(scene)
  const { label } = await readDistantRegion(scene)
  holdResponses = true
  await act(async () => label.element.querySelector<HTMLButtonElement>('.collaboration-area__fold')!.click())
  await settleCollaborationCanvas(() => expect(heldResponses.some(item => item.response.type === 'complete')).toBe(true))
  if (intent === 'pan') {
    await act(async () => captured.moveStart!(new MouseEvent('mousedown'), { x: -321, y: -654, zoom: .8 }))
    await viewport(-321, -654, 600, 400, .8)
  } else {
    await dom.render(graph(scene, null, scene.relations, [], scene.agents, { ready: true, locate: { token: {}, agentId: subject('canvas-1') } }))
  }
  await releasePlacement()
  await settleCollaborationCanvas(() => {
    const [x, y, zoom] = captured.store!.getState().transform
    if (intent === 'pan') expect([x, y, zoom]).toEqual([-321, -654, .8])
    else {
      const target = renderedBox(collaborationAgentNode('area-1', subject('canvas-1')))
      expect((target.x + target.width / 2) * zoom + x).toBeCloseTo(300, 4)
      expect((target.y + target.height / 2) * zoom + y).toBeCloseTo(200, 4)
    }
  })
})

it('measures a newly visible original Locate control as a region-label obstacle without changing world geometry', async () => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  const controlRect = new DOMRect(12, 12, 240, 32)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('collaboration-map__locate')) return controlRect
    return originalRect.call(this)
  })
  const scene = scenario(24); await loaded(scene)
  const area = renderedBox(JSON.stringify(['area', 'area-0'])) as Extract<engine.CollaborationLayoutBox, { kind: 'area' }>
  await viewport(-area.x - area.heading.x + 12, -area.y - area.heading.y + 12)
  expect(collaborationBoundsOverlap(regionLabelBounds('area-0'), controlRect)).toBe(true)
  const camera = captured.store!.getState().transform, geometry = captured.nodes.map(node => node.data.box), operations = requests.length, onLocate = vi.fn()
  await dom.render(graph(scene, null, scene.relations, [], scene.agents, { context: { name: 'Original reading context', onLocate } }))
  await settleCollaborationCanvas(() => {
    const labels = [...dom.container.querySelectorAll<HTMLElement>('[data-region-id]')]
    expect(labels.length).toBeGreaterThan(0)
    for (const label of labels) expect(collaborationBoundsOverlap(regionLabelBounds(label.dataset.regionId!), controlRect)).toBe(false)
  })
  const control = dom.container.querySelector<HTMLButtonElement>('.collaboration-map__locate')!
  expect(control.textContent).toContain('Original reading context')
  await act(async () => control.click()); expect(onLocate).toHaveBeenCalledOnce()
  expect(captured.store!.getState().transform).toBe(camera)
  expect(captured.nodes.map(node => node.data.box)).toEqual(geometry); expect(requests).toHaveLength(operations)
})

it('opens a real working region at readable scale instead of fitting many empty regions', async () => {
  const original = scenario(24)
  const agents = new Map([...original.agents].map(([id, agent]) => [id, { ...agent, tier: original.areas[2]!.members.includes(id) ? 'active' as const : 'unknown' as const }]))
  const empty: CollaborationArea[] = Array.from({ length: 60 }, (_, index) => ({ id: `empty-${index}`, name: `Empty ${index}`, kind: 'project', members: [] }))
  const scene = { ...original, agents, areas: [...empty, ...original.areas] }
  await dom.render(graph(scene, null, scene.relations, [], agents, { ready: true }))
  await settleCollaborationCanvas(() => {
    expect(captured.nodes).toHaveLength(88)
    expect(dom.container.querySelector('.collaboration-canvas__progress')).toBeNull()
    const [x, y, zoom] = captured.store!.getState().transform
    expect(zoom).toBeGreaterThanOrEqual(.7)
    expect(original.areas[2]!.members.some(id => {
      const box = renderedBox(collaborationAgentNode('area-2', id))
      return box.x * zoom + x < 600 && (box.x + box.width) * zoom + x > 0 && box.y * zoom + y < 400 && (box.y + box.height) * zoom + y > 0
    })).toBe(true)
    expect(dom.container.querySelectorAll('.focus-context').length).toBeGreaterThan(0)
  })
  await viewport(-333, -444)
  const selected = { kind: 'agent' as const, id: subject('canvas-2') }, operations = requests.length
  await dom.render(graph(scene, selected, scene.relations, [], new Map(agents), { ready: true }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)) })
  expect(captured.store!.getState().transform).toEqual([-333, -444, 1])
  expect(requests).toHaveLength(operations)
})

it('reads an exact deep occurrence when its original large parent heading is clicked', async () => {
  const scene = scenario(24), activeId = subject('canvas-23')
  scene.relations = []
  scene.agents = new Map([...scene.agents].map(([id, agent]) => [id, { ...agent, tier: id === activeId ? 'active' as const : 'idle' as const }]))
  scene.areas = [{ id: 'root', name: 'Original parent terrain', kind: 'project', members: [] },
    { id: 'middle', name: 'Original middle terrain', kind: 'category', parentId: 'root', members: [] },
    ...scene.areas.map(area => ({ ...area, parentId: 'middle' }))]
  const config = useAppStore.getState().config!
  useAppStore.setState({ config: { ...config, focus: { ...config.focus, mapMotion: 'off' } } })
  await loaded(scene)
  await dom.render(graph(scene, null, scene.relations, [], scene.agents, { ready: true, locate: { token: {}, agentId: activeId } }))
  const targetId = collaborationAgentNode('area-3', activeId), target = renderedBox(targetId)
  await settleCollaborationCanvas(() => expect(captured.store!.getState().transform[2]).toBe(1))
  const parent = renderedBox(JSON.stringify(['area', 'root']))
  expect(Math.min((600 - 96) / parent.width, (400 - 112) / parent.height)).toBeLessThan(.7)
  await viewport(-parent.x * .25 + 20, -parent.y * .25 + 20, 600, 400, .25)
  const nodes = captured.nodes, geometry = captured.nodes.map(node => node.data.box), operations = requests.length
  const heading = dom.container.querySelector<HTMLButtonElement>('[aria-label="Locate Original parent terrain · 24 Agents including subspaces"]')!
  expect(heading).not.toBeNull()
  await act(async () => heading.click())
  await settleCollaborationCanvas(() => {
    const [x, y, zoom] = captured.store!.getState().transform
    expect(zoom).toBe(.85)
    expect((target.x + target.width / 2) * zoom + x).toBeCloseTo(300, 5)
    expect((target.y + target.height / 2) * zoom + y).toBeCloseTo(200, 5)
  })
  expect(nodeElement(targetId)?.querySelector('.focus-context')).not.toBeNull()
  expect(captured.nodes).toBe(nodes); expect(captured.nodes.map(node => node.data.box)).toEqual(geometry)
  expect(requests).toHaveLength(operations); expect(open).not.toHaveBeenCalled()
})

it('reads a real folded descendant summary through its large parent heading without expanding the subtree', async () => {
  const scene = scenario(8); scene.relations = []
  const children = scene.areas
  scene.areas = [{ id: 'root', name: 'Original folded parent', kind: 'project', members: [] },
    { id: 'middle', name: 'Original middle', kind: 'category', parentId: 'root', members: [] },
    ...children.map(area => ({ ...area, parentId: 'middle' }))]
  const config = useAppStore.getState().config!
  useAppStore.setState({ config: { ...config, focus: { ...config.focus, mapMotion: 'off' } } })
  await loaded(scene)
  await dom.render(graph(scene, null, scene.relations, [], scene.agents, { ready: true, locate: { token: {}, agentId: subject('canvas-0') } }))
  await settleCollaborationCanvas(() => expect(captured.store!.getState().transform[2]).toBe(1))
  for (const area of children) {
    const id = JSON.stringify(['area', area.id]), box = renderedBox(id) as Extract<engine.CollaborationLayoutBox, { kind: 'area' }>
    await viewport(80 - (box.x + box.heading.x) * .85, 100 - (box.y + box.heading.y) * .85, 600, 400, .85)
    await dom.click(`[aria-label="Collapse ${area.name}"]`)
    await settleCollaborationCanvas(() => expect(renderedBox(id).folded).toBe(true))
  }
  expect(captured.nodes.some(node => node.type === 'agent')).toBe(false)
  const parent = renderedBox(JSON.stringify(['area', 'root']))
  expect(Math.min((600 - 96) / parent.width, (400 - 112) / parent.height)).toBeLessThan(.7)
  const folded = children.map(area => renderedBox(JSON.stringify(['area', area.id])))
  await viewport(-parent.x * .25 + 20, -parent.y * .25 + 20, 600, 400, .25)
  const nodes = captured.nodes, operations = requests.length
  await dom.click('[aria-label="Locate Original folded parent · 8 Agents including subspaces"]')
  await settleCollaborationCanvas(() => {
    const [x, y, zoom] = captured.store!.getState().transform
    expect(zoom).toBe(.85)
    expect(folded.some(box => Math.abs((box.x + box.width / 2) * zoom + x - 300) < 1e-5 && Math.abs((box.y + box.height / 2) * zoom + y - 200) < 1e-5)).toBe(true)
  })
  expect(captured.nodes).toBe(nodes); expect(requests).toHaveLength(operations)
  expect(captured.nodes.some(node => node.type === 'agent')).toBe(false)
  for (const box of folded) expect(renderedBox(box.id)).toBe(box)
})

it('overview keeps exact Agent endpoints without relayout and enters a named region through its control', async () => {
  const scene = scenario(24); await loaded(scene)
  const extent = [...boxes.values()], left = Math.min(...extent.map(box => box.x)), top = Math.min(...extent.map(box => box.y))
  const operations = requests.length, originalNodes = captured.nodes
  await viewport(-left * .25 + 20, -top * .25 + 20, 1600, 1200, .25)
  expect(captured.nodes).toBe(originalNodes)
  expect(dom.container.querySelectorAll('.focus-context')).toHaveLength(0)
  expect(dom.container.querySelectorAll('.collaboration-agent__mark strong')).toHaveLength(0)
  const edges = [...dom.container.querySelectorAll<SVGGElement>('.collaboration-connections .react-flow__edge')]
  expect(edges).toHaveLength(scene.relations.length)
  expect(edges.every(edge => !edge.getAttribute('aria-label')!.includes('Original area'))).toBe(true)
  const edge = edges.find(value => value.getAttribute('aria-label')!.includes('Agent 0 → Agent 1'))!
  expect(edge).toBeDefined(); expect(edge.getAttribute('aria-label')).toContain('original records')
  const connection = requests.flatMap(request => request.type === 'arrange' ? request.input.connections : []).find(connection => connection.id === edge.dataset.id)!
  const source = renderedBox(connection.source), target = renderedBox(connection.target)
  const ends = curvePoints(edge.querySelector('.react-flow__edge-path')!.getAttribute('d')!)
  const visibleRadius = (id: string) => {
    const mark = nodeElement(id)!.querySelector<HTMLElement>('.collaboration-agent__dot')!
    expect(mark.querySelector('.agent-avatar')).not.toBeNull()
    return Number.parseFloat(mark.style.width) / 2 * Number.parseFloat(mark.parentElement!.style.getPropertyValue('--collaboration-mark-scale'))
  }
  expect(Math.hypot(ends[0]!.x - source.x - source.width / 2, ends[0]!.y - source.y - source.height / 2)).toBeCloseTo(visibleRadius(connection.source))
  expect(Math.hypot(ends.at(-1)!.x - target.x - target.width / 2, ends.at(-1)!.y - target.y - target.height / 2)).toBeCloseTo(visibleRadius(connection.target))
  const envelopes = [...dom.container.querySelectorAll('.collaboration-area__envelope path')]
  expect(envelopes).toHaveLength(scene.areas.length)
  expect(envelopes.every(path => path.getAttribute('d')!.includes('Q'))).toBe(true)
  await act(async () => edge.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  const selected = select.mock.lastCall![0] as NonNullable<CollaborationSelection>
  expect(selected.kind).toBe('relation'); expect(selected.relatedIds).toEqual(['cross-0'])
  for (const id of selected.relatedIds!) {
    const relation = scene.relations.find(value => value.id === id)!
    expect(scene.areas[0]!.members).toContain(relation.source); expect(scene.areas[1]!.members).toContain(relation.target)
    expect(relation.kind).toBe('supervision')
  }
  // Camera labels retain the original area's identity and exact location action.
  const heading = dom.container.querySelector<HTMLButtonElement>('[aria-label="Locate Original area 0 · 6 Agents"]')!
  expect(heading).not.toBeNull()
  expect(heading.textContent).toContain('Original area 0')
  expect(heading.textContent).toContain('6')
  expect(heading.title).toContain('Project')
  const area = heading.closest<HTMLElement>('.collaboration-area__overview-label')!
  const areaBox = renderedBox(JSON.stringify(['area', 'area-0']))
  expect(areaBox.kind).toBe('area')
  expect(Number(area.dataset.labelWidth)).toBeGreaterThanOrEqual(104)
  expect(area.closest('.collaboration-region-labels')).not.toBeNull()
  const labelBounds = regionLabelBounds('area-0')
  // At overview scale, another original area's avatar can intersect the natural
  // heading position. The visible identity yields to those actual hit targets.
  const marks = [...dom.container.querySelectorAll<HTMLElement>('.collaboration-agent__dot')]
  expect(marks.length).toBeGreaterThan(0)
  for (const mark of marks) {
    const node = mark.closest<HTMLElement>('.react-flow__node')!, box = renderedBox(node.dataset.id!)
    const size = Number.parseFloat(mark.style.width) * Number.parseFloat(mark.parentElement!.style.getPropertyValue('--collaboration-mark-scale'))
    expect(Number.isFinite(size) && size > 0).toBe(true)
    const hit = { x: (box.x + (box.width - size) / 2 - left) * .25 + 20, y: (box.y + (box.height - size) / 2 - top) * .25 + 20, width: size * .25, height: size * .25 }
    expect(collaborationBoundsOverlap(labelBounds, hit)).toBe(false)
  }
  await dom.render(graph(scene, null, scene.relations, [], scene.agents, { ready: true }))
  // Locate is an explicit control intent, so it is allowed to replace this already-set camera.
  await viewport(-left * .25 + 20, -top * .25 + 20, 1600, 1200, .25)
  await act(async () => dom.container.querySelector<HTMLButtonElement>('[aria-label="Locate Original area 0 · 6 Agents"]')!.click())
  await settleCollaborationCanvas(() => expect(captured.store!.getState().transform[2]).toBeGreaterThanOrEqual(.7))
  expect(requests).toHaveLength(operations)
  expect(open).not.toHaveBeenCalled()
})

it('anchors an unobstructed overview identity to the original Worker heading baseline', async () => {
  const scene = scenario(0); scene.areas = [scene.areas[0]!]; scene.relations = []
  await loaded(scene)
  const box = renderedBox(JSON.stringify(['area', 'area-0'])) as Extract<engine.CollaborationLayoutBox, { kind: 'area' }>
  const zoom = .25, x = 100 - (box.x + box.heading.x) * zoom, y = 100 - (box.y + box.heading.y) * zoom
  await viewport(x, y, 600, 400, zoom)
  expect(dom.container.querySelectorAll('[data-region-id]')).toHaveLength(1)
  expect(dom.container.querySelectorAll('.collaboration-agent')).toHaveLength(0)
  const label = regionLabelBounds('area-0')
  expect(label.element.dataset.context).toBeUndefined()
  expect(label.x).toBeCloseTo(100, 6)
  expect(label.y + label.height).toBeCloseTo(100 + box.heading.height * zoom, 6)
  expect(requests).toHaveLength(1)
})

it('selecting an Agent highlights only its original relations while preserving every other connection', async () => {
  const scene = scenario(24); await loaded(scene)
  const extent = [...boxes.values()], left = Math.min(...extent.map(box => box.x)), top = Math.min(...extent.map(box => box.y))
  await viewport(-left + 20, -top + 20, 20000, 20000, 1)
  const before = [...dom.container.querySelectorAll<SVGGElement>('.collaboration-connections .react-flow__edge')].map(edge => edge.dataset.id)
  const operations = requests.length
  await dom.render(graph(scene, { kind: 'agent', id: subject('canvas-0') }))
  const after = [...dom.container.querySelectorAll<SVGGElement>('.collaboration-connections .react-flow__edge')]
  expect(after.map(edge => edge.dataset.id)).toEqual(before)
  expect(after.filter(edge => edge.dataset.emphasis === 'related')).toHaveLength(2)
  expect(after.filter(edge => edge.dataset.emphasis === 'muted').length).toBeGreaterThan(0)
  expect(requests).toHaveLength(operations)
})


it('keeps every selected original relation emphasized when an explicitly folded group expands', async () => {
  const scene = scenario(24); await loaded(scene)
  for (const area of scene.areas) {
    await focusNode(JSON.stringify(['area', area.id]))
    await act(async () => dom.container.querySelector<HTMLButtonElement>(`[data-region-id='${area.id}'] .collaboration-area__fold`)!.click())
    await settleCollaborationCanvas(() => expect(dom.container.querySelector('.collaboration-canvas__progress')).toBeNull())
  }
  const extent = [...boxes.values()], left = Math.min(...extent.map(box => box.x)), top = Math.min(...extent.map(box => box.y))
  await viewport(-left * .25 + 20, -top * .25 + 20, 1600, 1200, .25)
  const group = [...dom.container.querySelectorAll<SVGGElement>('.collaboration-connections .react-flow__edge')]
    .find(edge => edge.getAttribute('aria-label')!.includes('Original area 0 → Original area 1'))!
  await act(async () => group.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  const selection = select.mock.lastCall![0] as NonNullable<CollaborationSelection>
  expect(selection.relatedIds!.length).toBeGreaterThan(1)
  await dom.render(graph(scene, selection))
  for (const area of scene.areas) {
    await focusNode(JSON.stringify(['area', area.id]))
    await act(async () => dom.container.querySelector<HTMLButtonElement>(`[data-region-id='${area.id}'] .collaboration-area__fold`)!.click())
    await settleCollaborationCanvas(() => expect(dom.container.querySelector('.collaboration-canvas__progress')).toBeNull())
  }
  const operations = requests.length
  await viewport(10000, 10000, 40000, 40000, 1)
  const edges = [...dom.container.querySelectorAll<SVGGElement>('.collaboration-connections .react-flow__edge')]
  const selected = edges.filter(edge => edge.getAttribute('aria-pressed') === 'true')
  expect(edges).toHaveLength(scene.relations.length)
  expect(selected).toHaveLength(selection.relatedIds!.length)
  expect(selected.every(edge => edge.dataset.emphasis === 'related')).toBe(true)
  expect(edges.filter(edge => edge.dataset.emphasis === 'muted')).toHaveLength(scene.relations.length - selected.length)
  expect(requests).toHaveLength(operations)
})


it('adopts parent-relative positions when a local resize expands the original area toward the left', async () => {
  const initial = scenario(24), agents = new Map([...initial.agents].map(([id, agent]) => [id, { ...agent, tier: 'idle' as const }]))
  const scene = { ...initial, agents }; await loaded(scene)
  const areaId = JSON.stringify(['area', 'area-0']), area = renderedBox(areaId)
  const members = captured.nodes.filter(node => node.type === 'agent' && node.parentId === areaId).sort((a, b) => renderedBox(a.id).x - renderedBox(b.id).x)
  const reading = members[0]!, agent = reading.data.agent as CollaborationAgent
  await pointAt(reading.id)
  const changed = new Map(agents); changed.set(agent.id, { ...agent, tier: 'active' })
  await dom.render(graph(scene, null, scene.relations, [], changed))
  await settleCollaborationCanvas(() => {
    expect(requests).toHaveLength(2); expect(dom.container.querySelector('.collaboration-canvas__progress')).toBeNull()
    expect(renderedBox(areaId).x).toBeLessThan(area.x)
  })
  for (const node of captured.nodes) {
    const world = captured.store!.getState().nodeLookup.get(node.id)!.internals.positionAbsolute, expected = renderedBox(node.id)
    expect(world.x, node.id).toBeCloseTo(expected.x, 6); expect(world.y, node.id).toBeCloseTo(expected.y, 6)
  }
})


it('rebuilds the real envelope when current members change inside identical enclosing bounds', async () => {
  // Controlled Worker receipts isolate the renderer cache; the finite engine has its own real tests.
  vi.mocked(engine.handleCollaborationLayoutRequest).mockImplementation(async (request, publish) => {
    if (request.type === 'route') throw Error('This geometry-only scene has no connections')
    const area = request.input.areas[0]!, points = [[0, 0], [600, 0], [0, 600], [400, 400]]
    publish({ id: request.id, type: 'boxes', retainedPaths: request.type === 'reconcile' ? [] : undefined, boxes: [
      { id: area.id, areaId: area.id, kind: 'area', folded: false, x: -24, y: -104, width: 672, height: 752, heading: { x: 24, y: 24, width: 184, height: 40 } },
      ...request.input.nodes.map((node, index) => ({ ...node, kind: 'agent' as const, folded: false, x: points[index]![0]!, y: points[index]![1]! }))
    ] })
    publish({ id: request.id, type: 'complete' })
  })
  const initial = scenario(3), agents = new Map([...initial.agents].map(([id, agent]) => [id, { ...agent, tier: 'closed' as const }]))
  const area: CollaborationArea = { id: 'triangle', name: 'Original members', kind: 'project', members: [...agents.keys()] }
  const scene = { ...initial, agents, areas: [area], relations: [] }; await loaded(scene)
  const areaId = JSON.stringify(['area', 'triangle']), before = renderedBox(areaId)
  const originalPath = dom.container.querySelector('.collaboration-area__envelope path')!.getAttribute('d')!
  const fourth = scenario(4).agents.get(subject('canvas-3'))!, nextAgents = new Map(agents)
  nextAgents.set(fourth.id, { ...fourth, tier: 'closed' })
  const next = { ...scene, agents: nextAgents, areas: [{ ...area, members: [...area.members, fourth.id] }] }
  await dom.render(graph(next))
  await settleCollaborationCanvas(() => {
    expect(captured.nodes.filter(node => node.type === 'agent')).toHaveLength(4)
    expect(dom.container.querySelector('.collaboration-area__envelope path')!.getAttribute('d')).not.toBe(originalPath)
  })
  expect(renderedBox(areaId)).toBe(before)
})

it('shows immediate source and recipient activity while the original new path is still arriving', async () => {
  const original = scenario(24), scene = { ...original, relations: [] }; await loaded(scene)
  const source = collaborationAgentNode('area-0', subject('canvas-0')), target = collaborationAgentNode('area-1', subject('canvas-1'))
  await focusNode(source)
  const pulse = { id: 1, startedAt: Date.now(), hostId: 'local', sender: 'canvas-0', recipient: 'canvas-1', kind: 'communication' as const }
  const relation: CollaborationRelation = { id: 'new-message', source: subject('canvas-0'), target: subject('canvas-1'), kind: 'communication', evidence: [] }
  holdResponses = true
  await dom.render(graph(scene, null, [relation], [pulse]))
  expect(nodeElement(source)!.querySelector('[aria-label="Message sent"]')).not.toBeNull()
  expect(dom.container.querySelector('[aria-label="Relation legend"]')!.textContent).toContain('Messages')
  expect(dom.container.querySelector('.collaboration-edge__pulse')).toBeNull()
  await settleCollaborationCanvas(() => expect(heldResponses.some(item => item.response.type === 'complete')).toBe(true))
  await releasePlacement()
  await settleCollaborationCanvas(() => expect(dom.container.querySelector('.collaboration-edge__pulse')).not.toBeNull())
  const flow = dom.container.querySelector<SVGPathElement>('.collaboration-edge__pulse')!
  expect(Number.parseFloat(flow.style.animationDelay)).toBeLessThan(0)
  const packet = dom.container.querySelector<SVGCircleElement>('.collaboration-edge__packet')!
  expect(packet).not.toBeNull()
  expect(packet.getAttribute('data-kind')).toBe('communication')
  expect(packet.style.offsetPath).toBe(`path("${flow.getAttribute('d')}")`)
  expect(packet.style.animationDelay).toBe(flow.style.animationDelay)
  expect(dom.container.querySelector<HTMLElement>('.collaboration-canvas')!.style.getPropertyValue('--collaboration-activity-duration')).toBe(`${COLLABORATION_ACTIVITY_MS}ms`)
  expect(Number(packet.getAttribute('r'))).toBe(4)
  await focusNode(target)
  expect(nodeElement(target)!.querySelector('[aria-label="Message received"]')).not.toBeNull()
  const edge = dom.container.querySelector<SVGGElement>('.collaboration-connections .react-flow__edge')!
  await act(async () => edge.dispatchEvent(new FocusEvent('focusin', { bubbles: true })))
  expect(document.getElementById(edge.getAttribute('aria-describedby')!)!.textContent).toContain('Messages: Agent 0 → Agent 1')
  const operations = requests.length, camera = captured.store!.getState().transform
  await viewport(camera[0] * .25, camera[1] * .25, 20000, 20000, .25)
  const overviewPacket = dom.container.querySelector<SVGCircleElement>('.collaboration-edge__packet')!
  const overviewPath = dom.container.querySelector<SVGPathElement>('.collaboration-edge__pulse')!
  expect(Number(overviewPacket.getAttribute('r')) * .25).toBe(4)
  expect(overviewPacket.style.offsetPath).toBe(`path("${overviewPath.getAttribute('d')}")`)
  expect(overviewPacket.style.animationDelay).toBe(overviewPath.style.animationDelay)
  expect(requests).toHaveLength(operations)
})

it('keeps named region labels separated at distant scale without changing world geometry', async () => {
  const scene = scenario(24); await loaded(scene)
  const before = captured.nodes, operations = requests.length
  const extent = [...boxes.values()], left = Math.min(...extent.map(box => box.x)), top = Math.min(...extent.map(box => box.y))
  await viewport(-left * .06 + 20, -top * .06 + 60, 560, 360, .06)
  const labels = [...dom.container.querySelectorAll<HTMLElement>('.collaboration-area__overview-label')]
  expect(labels).toHaveLength(scene.areas.length)
  for (const label of labels) {
    const button = label.querySelector<HTMLButtonElement>('button')!
    expect(button.textContent).toContain('Original area')
    expect(button.textContent).toContain('6')
    expect(button.title).toContain('Project')
    expect(button.querySelector('svg')).not.toBeNull()
    expect(Number(label.dataset.labelWidth)).toBeGreaterThanOrEqual(104)
  }
  for (let index = 0; index < labels.length; index++) for (const other of labels.slice(index + 1)) {
    const label = labels[index]!, x = Number.parseFloat(label.style.left), y = Number.parseFloat(label.style.top)
    const ox = Number.parseFloat(other.style.left), oy = Number.parseFloat(other.style.top)
    expect(x + Number(label.dataset.labelWidth) <= ox || ox + Number(other.dataset.labelWidth) <= x || y + Number(label.dataset.labelHeight) <= oy || oy + Number(other.dataset.labelHeight) <= y).toBe(true)
  }
  expect(captured.nodes).toBe(before); expect(requests).toHaveLength(operations)
})

it('retains exact region context when reading a member with its original heading offscreen', async () => {
  const scene = scenario(24); await loaded(scene)
  const area = renderedBox(JSON.stringify(['area', 'area-0'])) as Extract<engine.CollaborationLayoutBox, { kind: 'area' }>
  const members = scene.areas[0]!.members.map(id => renderedBox(collaborationAgentNode('area-0', id)))
  const distant = [...members].sort((a, b) => Math.hypot(b.x - area.x - area.heading.x, b.y - area.y - area.heading.y) - Math.hypot(a.x - area.x - area.heading.x, a.y - area.y - area.heading.y))[0]!
  const before = captured.nodes, operations = requests.length
  await viewport(-distant.x + 20, -distant.y + 20, 300, 180)
  const label = dom.container.querySelector<HTMLElement>(`[data-area-id='${area.id}'][data-context=true]`)!
  expect(label).not.toBeNull()
  expect(label.textContent).toContain('Original area 0')
  expect(label.textContent).toContain('6')
  expect(label.querySelector('button')!.getAttribute('title')).toContain('Project')
  expect(Number.parseFloat(label.style.left)).toBeGreaterThanOrEqual(0)
  expect(Number.parseFloat(label.style.top) + Number(label.dataset.labelHeight)).toBeLessThanOrEqual(180)
  expect(captured.nodes).toBe(before); expect(requests).toHaveLength(operations)
})

it('keeps every real ancestor readable and foldable while its deep Agent is read below the original headings', async () => {
  const scene = scenario(12)
  scene.areas = [{ id: 'project', name: 'Original project', kind: 'project', members: [] },
    { id: 'category', name: 'Original category', kind: 'category', parentId: 'project', members: [] },
    { id: 'topic', name: 'Original topic', kind: 'topic', parentId: 'category', members: [...scene.agents.keys()] }]
  await loaded(scene)
  const deepest = captured.nodes.filter(node => node.type === 'agent').sort((a, b) => (b.data.box as engine.CollaborationLayoutBox).y - (a.data.box as engine.CollaborationLayoutBox).y)[0]!
  const box = deepest.data.box as engine.CollaborationLayoutBox
  const before = captured.nodes, operations = requests.length
  await viewport(-box.x + 40, -box.y + 100, 800, 400)
  for (const id of ['project', 'category', 'topic']) {
    const area = renderedBox(JSON.stringify(['area', id])) as Extract<engine.CollaborationLayoutBox, { kind: 'area' }>
    expect(area.y + area.heading.y - box.y + 100).toBeLessThan(0)
    const label = dom.container.querySelector<HTMLElement>(`[data-region-id="${id}"]`)!
    expect(label, `The original ${id} remains visible beside its deep member`).not.toBeNull()
    expect(label.dataset.context).toBe('true')
    expect(label.querySelector('[aria-expanded="true"]')).not.toBeNull()
  }
  expect(captured.nodes).toBe(before)
  expect(requests).toHaveLength(operations)
})

it('keeps projected region labels clear of original Agent hit targets through camera LOD', async () => {
  const scene = scenario(24); await loaded(scene)
  const area = renderedBox(JSON.stringify(['area', 'area-0'])) as Extract<engine.CollaborationLayoutBox, { kind: 'area' }>
  const members = scene.areas[0]!.members.map(id => renderedBox(collaborationAgentNode('area-0', id)))
  const distant = [...members].sort((a, b) => b.y - a.y)[0]!
  const before = captured.nodes, operations = requests.length
  const query = vi.spyOn(CollaborationBoundsIndex.prototype, 'query')
  for (const [x, y, zoom, width, height] of [[-distant.x + 20, -distant.y + 52, 1, 420, 320], [-area.x * .12 + 40, -area.y * .12 + 60, .12, 640, 400]]) {
    await viewport(x!, y!, width!, height!, zoom!)
    const labels = [...dom.container.querySelectorAll<HTMLElement>('.collaboration-area__overview-label')]
    expect(labels.some(label => label.dataset.areaId === area.id)).toBe(true)
    const hits = captured.nodes.filter(node => node.type === 'agent').flatMap(node => {
      const element = nodeElement(node.id)?.querySelector<HTMLElement>('.collaboration-agent')
      if (!element) return []
      const box = node.data.box as engine.CollaborationLayoutBox
      const dot = element.querySelector<HTMLButtonElement>('.collaboration-agent__dot')
      const size = dot ? Number.parseFloat(dot.style.width) * Number.parseFloat(element.style.getPropertyValue('--collaboration-mark-scale')) : undefined
      const hit = size ? { x: box.x + (box.width - size) / 2, y: box.y + (box.height - size) / 2, width: size, height: size } : box
      return { x: hit.x * zoom! + x!, y: hit.y * zoom! + y!, width: hit.width * zoom!, height: hit.height * zoom! }
    })
    expect(hits.length).toBeGreaterThan(0)
    for (const label of labels) {
      const rect = { x: Number.parseFloat(label.style.left), y: Number.parseFloat(label.style.top), width: Number(label.dataset.labelWidth), height: Number(label.dataset.labelHeight) }
      expect(hits.some(hit => collaborationBoundsOverlap(rect, hit))).toBe(false)
    }
  }
  expect(query).toHaveBeenCalled()
  expect(captured.nodes).toBe(before); expect(requests).toHaveLength(operations)
})

it('reads the complete original relation in the window tooltip and releases it when the retained map hides', async () => {
  const scene = await loadedDetourScene(), connection = detour()!.connection
  await revealWorld()
  const edge = edgeElement(connection.id)!, label = edge.getAttribute('aria-label')!, before = captured.nodes, operations = requests.length
  expect(label).toContain('Messages:'); expect(label).toContain('→'); expect(label).toContain('original records')
  expect(edge.querySelector('title')).toBeNull()
  await dom.render(graph(scene, { kind: 'relation', id: scene.relations[0]!.id }))
  expect(dom.container.querySelector('.collaboration-edge__label')).toBeNull()
  expect(edge.getAttribute('aria-describedby')).toBeNull()
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
  await act(async () => edge.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  const description = document.getElementById(edge.getAttribute('aria-describedby')!)!
  expect(description).not.toBeNull(); expect(description.getAttribute('role')).toBe('tooltip'); expect(description.textContent).toBe(label)
  expect(description.closest('[data-overlay-layer="tooltip"]')).not.toBeNull()
  expect(dom.container.contains(description)).toBe(false)
  await act(async () => edge.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })))
  await act(async () => new Promise(resolve => setTimeout(resolve, 150)))
  expect(description.isConnected).toBe(false)
  await act(async () => edge.focus())
  expect(document.activeElement).toBe(edge)
  expect(document.getElementById(edge.getAttribute('aria-describedby')!)?.textContent).toBe(label)
  await act(async () => edge.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })))
  await act(async () => new Promise(resolve => setTimeout(resolve, 150)))
  expect(document.getElementById(edge.getAttribute('aria-describedby')!)?.textContent).toBe(label)
  await act(async () => edge.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await act(async () => new Promise(resolve => setTimeout(resolve, 150)))
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
  expect(select).toHaveBeenLastCalledWith(null)
  await act(async () => { edge.blur(); edge.focus() })
  expect(document.getElementById(edge.getAttribute('aria-describedby')!)?.textContent).toBe(label)
  await dom.render(graph(scene, null, scene.relations, [], scene.agents, { active: false }))
  expect(document.querySelector('[role="tooltip"]')).toBeNull(); expect(edgeElement(connection.id)).toBe(edge)
  await dom.render(graph(scene)); expect(document.querySelector('[role="tooltip"]')).toBeNull()
  expect(captured.nodes).toBe(before); expect(requests).toHaveLength(operations)
})

it('tracks a transformed original SVG path through real FloatingUI without following its live packet', async () => {
  const scene = await loadedDetourScene(), connection = detour()!.connection
  const original = selectedRelation(scene, connection.source, connection.target, connection.kind), from = scene.agents.get(original.source)!, to = scene.agents.get(original.target)!
  await dom.render(graph(scene, null, scene.relations, [{ id: 1, startedAt: Date.now(), hostId: 'local', sender: from.sessionId!, recipient: to.sessionId!, kind: 'communication' }]))
  await revealWorld()
  const edge = edgeElement(connection.id)!, path = edge.querySelector<SVGPathElement>('.react-flow__edge-path')!
  const packet = edge.querySelector<SVGCircleElement>('.collaboration-edge__packet')!
  expect(packet).not.toBeNull()
  const readPacket = vi.spyOn(packet, 'getBoundingClientRect').mockImplementation(() => new DOMRect(900, 80, 8, 8))
  let screen = new DOMRect(120, 100, 160, 40)
  const readPath = vi.spyOn(path, 'getBoundingClientRect').mockImplementation(() => screen)
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1200)
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(800)
  await act(async () => edge.dispatchEvent(new FocusEvent('focusin', { bubbles: true })))
  const panel = document.getElementById(edge.getAttribute('aria-describedby')!)!
  Object.defineProperties(panel, { offsetWidth: { configurable: true, get: () => 180 }, offsetHeight: { configurable: true, get: () => 52 } })
  vi.spyOn(panel, 'getBoundingClientRect').mockImplementation(() => new DOMRect(Number.parseFloat(panel.style.left) || 0, Number.parseFloat(panel.style.top) || 0, 180, 52))
  screen = new DOMRect(160, 160, 160, 40)
  await act(async () => vi.waitFor(() => { expect(panel.style.visibility).toBe('visible'); expect(Number.parseFloat(panel.style.top)).toBeCloseTo(208) }))
  const initial = { x: Number.parseFloat(panel.style.left), y: Number.parseFloat(panel.style.top) }, reads = readPath.mock.calls.length, operations = requests.length
  screen = new DOMRect(300, 230, 160, 40)
  await act(async () => vi.waitFor(() => { expect(Number.parseFloat(panel.style.left)).toBeCloseTo(initial.x + 140); expect(Number.parseFloat(panel.style.top)).toBeCloseTo(initial.y + 70) }))
  expect(readPath.mock.calls.length).toBeGreaterThan(reads)
  expect(readPacket).not.toHaveBeenCalled()
  expect(document.getElementById(edge.getAttribute('aria-describedby')!)).toBe(panel)
  expect(requests).toHaveLength(operations)
  await dom.render(graph(scene, null, scene.relations, [], scene.agents, { active: false }))
  const stopped = readPath.mock.calls.length
  await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  expect(readPath).toHaveBeenCalledTimes(stopped); expect(panel.isConnected).toBe(false)
})

it('starts original SVG tooltip observation outside its mounting turn and cancels both pending and active work', async () => {
  const scene = await loadedDetourScene(), connection = detour()!.connection
  await revealWorld()
  const edge = edgeElement(connection.id)!, originalObserver = globalThis.ResizeObserver
  const observed = new Set<Element>(), frames = new Map<number, FrameRequestCallback>(); let sequence = 0
  vi.stubGlobal('ResizeObserver', class extends originalObserver {
    observe(target: Element, options?: ResizeObserverOptions) { observed.add(target); super.observe(target, options) }
    unobserve(target: Element) { observed.delete(target); super.unobserve(target) }
    disconnect() { observed.clear(); super.disconnect() }
  })
  const frameSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++sequence, callback); return sequence })
  const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id) })
  try {
    await act(async () => edge.dispatchEvent(new FocusEvent('focusin', { bubbles: true })))
    const pendingPanel = document.getElementById(edge.getAttribute('aria-describedby')!)!
    expect(pendingPanel).not.toBeNull(); expect(pendingPanel.style.visibility).toBe('visible')
    expect(observed.has(pendingPanel)).toBe(false)
    expect(frames.size).toBe(1)
    await dom.render(graph(scene, null, scene.relations, [], scene.agents, { active: false }))
    expect(frames.size).toBe(0); expect(observed.size).toBe(0); expect(pendingPanel.isConnected).toBe(false)
    await dom.render(graph(scene))
    const regionFrames = frames.size
    await act(async () => edge.dispatchEvent(new FocusEvent('focusin', { bubbles: true })))
    const activePanel = document.getElementById(edge.getAttribute('aria-describedby')!)!
    expect(activePanel).not.toBeNull(); expect(observed.has(activePanel)).toBe(false); expect(frames.size).toBe(regionFrames + 1)
    await act(async () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(performance.now()) })
    expect(observed.has(activePanel)).toBe(true)
    expect(frames.size).toBe(1)
    await dom.render(graph(scene, null, scene.relations, [], scene.agents, { active: false }))
    expect(frames.size).toBe(0); expect(observed.size).toBe(0); expect(activePanel.isConnected).toBe(false)
  } finally { frameSpy.mockRestore(); cancelSpy.mockRestore(); vi.stubGlobal('ResizeObserver', originalObserver) }
})

it('reserves the same region activity slot and geometry before during and after an original pulse', async () => {
  const scene = scenario(24); await loaded(scene)
  const area = boxes.get(JSON.stringify(['area', 'area-0']))!
  await viewport(-area.x * .25 + 20, -area.y * .25 + 20, 1600, 1200, .25)
  const label = dom.container.querySelector<HTMLElement>(`[data-area-id='${area.id}']`)!, slot = label.querySelector<HTMLElement>('.collaboration-area__activity')!
  expect(slot).not.toBeNull(); expect(slot.getAttribute('aria-hidden')).toBe('true'); expect(slot.hasAttribute('data-kind')).toBe(false)
  const before = label.getAttribute('style'), name = label.querySelector('.collaboration-area__name strong')!, count = label.querySelector('small')!, geometry = captured.nodes.map(node => [node.id, node.position, node.data.box]), operations = requests.length
  const pulse: CollaborationPulse = { id: 1, startedAt: Date.now(), hostId: 'local', sender: 'canvas-0', recipient: 'canvas-1', kind: 'communication' }
  await dom.render(graph(scene, null, scene.relations, [pulse]))
  expect(label.getAttribute('style')).toBe(before); expect(label.querySelector('.collaboration-area__activity')).toBe(slot)
  expect(slot.getAttribute('data-kind')).toBe('communication'); expect(slot.getAttribute('aria-label')).toBe('Recent message activity'); expect(slot.getAttribute('aria-hidden')).toBeNull()
  expect(label.querySelector('.collaboration-area__name strong')).toBe(name); expect(label.querySelector('small')).toBe(count)
  await dom.render(graph(scene))
  expect(label.getAttribute('style')).toBe(before); expect(label.querySelector('.collaboration-area__activity')).toBe(slot)
  expect(slot.getAttribute('aria-hidden')).toBe('true'); expect(slot.hasAttribute('data-kind')).toBe(false)
  expect(captured.nodes.map(node => [node.id, node.position, node.data.box])).toEqual(geometry); expect(requests).toHaveLength(operations)
})


it('keeps the exact reading occurrence and translates all curves through an explicit rearrangement', async () => {
  const initial = scenario(24), scene = { ...initial, areas: initial.areas.map((area, index) => index === 3 ? { ...area, members: [...area.members, subject('canvas-0')] } : area) }; await loaded(scene)
  const reading = collaborationAgentNode('area-3', subject('canvas-0'))
  await pointAt(reading)
  await act(async () => nodeElement(reading)!.querySelector<HTMLButtonElement>('.focus-context')!.click())
  const extra: CollaborationRelation[] = Array.from({ length: 6 }, (_, index) => ({ id: 'observed-' + index, source: subject('canvas-1'), target: subject('canvas-' + (index * 3 + 2)), kind: 'communication', evidence: [] }))
  await dom.render(graph(scene, null, [...scene.relations, ...extra]))
  await settleCollaborationCanvas(() => { expect(requests).toHaveLength(2); expect(dom.container.querySelector('.collaboration-canvas__progress')).toBeNull() })
  const before = renderedBox(reading), camera = captured.store!.getState().transform
  holdResponses = true
  await act(async () => dom.container.querySelector<HTMLButtonElement>('[aria-label="Arrange map"]')!.click())
  await settleCollaborationCanvas(() => expect(heldResponses.some(item => item.response.type === 'complete')).toBe(true))
  const placement = heldResponses.find(item => item.response.type === 'boxes')!.response
  if (placement.type !== 'boxes') throw Error('Original force placement required')
  const raw = placement.boxes.find(box => box.id === reading)!, offset = { x: before.x - raw.x, y: before.y - raw.y }
  expect(Math.abs(offset.x) + Math.abs(offset.y)).toBeGreaterThan(.1)
  await releasePlacement()
  expect([renderedBox(reading).x, renderedBox(reading).y]).toEqual([before.x, before.y]); expect(captured.store!.getState().transform).toBe(camera)
  const all = [...boxes.values()], left = Math.min(...all.map(box => box.x + offset.x)), top = Math.min(...all.map(box => box.y + offset.y))
  await viewport(-left + 20, -top + 20, 20000, 20000, 1)
  const edges = [...dom.container.querySelectorAll<SVGGElement>('.collaboration-connections .react-flow__edge')]
  expect(edges).toHaveLength(paths.size)
  for (const edge of edges) {
    const rawPath = paths.get(edge.dataset.id!)!, curve = curvePoints(edge.querySelector('.react-flow__edge-path')!.getAttribute('d')!)
    expectAnchoredVisibleCurve(rawPath, curve, offset)
  }
})


it('keeps local route diagnostics inspectable and retries only the failed original connection', async () => {
  const scene = scenario(24), diagnostic = 'Connection routing crosses original card ["original-owner","original-peer"]. Retry this same connection.'
  let failing = true, failedId = ''
  vi.mocked(engine.handleCollaborationLayoutRequest).mockImplementation((request, publish, signal) => {
    if (request.type === 'arrange') failedId = request.input.connections[0]!.id
    return originalDispatch(request, response => {
      if (response.type === 'paths' && failing && response.paths[failedId]) {
        const paths = { ...response.paths }; delete paths[failedId]
        if (Object.keys(paths).length) publish({ ...response, paths })
        publish({ id: request.id, type: 'error', connectionId: failedId, message: diagnostic })
      } else publish(response)
    }, signal)
  })
  await dom.render(graph(scene))
  await settleCollaborationCanvas(() => expect(dom.container.querySelector('.collaboration-canvas__issue details p')?.textContent).toBe(diagnostic))
  const issue = dom.container.querySelector('.collaboration-canvas__issue')!
  expect(issue.querySelector(':scope > span')?.textContent).toBe('1 connection could not be drawn. Original records remain readable.')
  expect(issue.querySelector('details')?.hasAttribute('open')).toBe(false)
  expect(captured.nodes).toHaveLength(28)
  const originals = captured.nodes
  await focusNode(collaborationAgentNode(scene.areas[0]!.id, subject('canvas-0')))
  const card = dom.container.querySelector('.focus-context[data-session-id="canvas-0"]')!
  expect(card).not.toBeNull()
  await act(async () => card.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(select).toHaveBeenCalledWith({ kind: 'agent', id: subject('canvas-0') })
  failing = false
  await act(async () => issue.querySelector('button')!.click())
  await settleCollaborationCanvas(() => expect(dom.container.querySelector('.collaboration-canvas__issue')).toBeNull())
  const retry = requests.at(-1)!
  expect(retry.type).toBe('route'); if (retry.type !== 'route') throw Error('Original connection retry required')
  expect(retry.connections).toHaveLength(1); expect(retry.connections[0]!.id).toBe(failedId)
  expect(captured.nodes).toBe(originals)
})


it('the formal motion control changes only original event presentation and resumes its elapsed phase', async () => {
  const scene = scenario(24); await loaded(scene); await revealWorld()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(10000)
  let config = useAppStore.getState().config!
  const save = vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => {
    config = applyConfigEdit(config, expected, next); useAppStore.setState({ config }); return config
  })
  const pulse: CollaborationPulse = { id: 1, startedAt: 9600, hostId: 'local', sender: 'canvas-0', recipient: 'canvas-4', kind: 'communication' }
  const selected: CollaborationSelection = { kind: 'agent', id: subject('canvas-0') }
  await dom.render(graph(scene, selected, scene.relations, [pulse]))
  const control = dom.container.querySelector<HTMLButtonElement>('[aria-label="Map animations"]')!
  expect(control.getAttribute('aria-pressed')).toBe('true')
  expect(dom.container.querySelector('.collaboration-edge__packet')).not.toBeNull()
  const camera = captured.store!.getState().transform, geometry = captured.nodes.map(node => node.data.box), operations = requests.length
  await dom.click('[aria-label="Map animations"]')
  expect(save).toHaveBeenCalledOnce(); expect(config.focus?.mapMotion).toBe('off')
  expect(control.getAttribute('aria-pressed')).toBe('false')
  expect(dom.container.querySelector('.collaboration-canvas')?.getAttribute('data-motion')).toBe('off')
  expect(dom.container.querySelector('.collaboration-edge__packet')).toBeNull()
  expect(dom.container.querySelector('.collaboration-edge__pulse')).toBeNull()
  expect(dom.container.querySelector('.react-flow__edge[data-recent="true"]')).not.toBeNull()
  expect(dom.container.querySelector('[aria-label="Message received"]')).not.toBeNull()
  clock.mockReturnValue(10800)
  await dom.click('[aria-label="Map animations"]')
  expect(control.getAttribute('aria-pressed')).toBe('true'); expect(config.focus?.mapMotion).toBe('on')
  expect(dom.container.querySelector<SVGPathElement>('.collaboration-edge__pulse')?.style.animationDelay).toBe('-1200ms')
  expect(captured.store!.getState().transform).toBe(camera)
  expect(captured.nodes.map(node => node.data.box)).toEqual(geometry); expect(requests).toHaveLength(operations)
  expect(select).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled()
  // The original reading owner expires activity. Preferences never retain or replay it.
  await dom.render(graph(scene, selected)); await dom.click('[aria-label="Map animations"]'); await dom.click('[aria-label="Map animations"]')
  expect(dom.container.querySelector('.collaboration-edge__packet')).toBeNull()
  expect(dom.container.querySelector('[aria-label="Message received"]')).toBeNull()
  expect(requests).toHaveLength(operations)
})

it('projects complete region identities and original Host and avatars without replacing map geometry', async () => {
  const scene = scenario(24), name = 'AgentMux 协作协议与持久运行工作区'
  scene.areas = scene.areas.map((area, index) => index === 0 ? { ...area, name, hostId: 'remote', iconTarget: { kind: 'folder', key: 'project-source', name } }
    : index === 1 ? { ...area, kind: 'mote', name: '设计与交互', hostId: 'local', iconTarget: { kind: 'mote', key: 'mote-source', name: '设计与交互' } }
    : index === 2 ? { ...area, kind: 'topic', name: '通信实验', hostId: 'local' } : area)
  const config = useAppStore.getState().config!
  useAppStore.setState({ config: { ...config, hosts: [...config.hosts, { id: 'remote', kind: 'ssh', label: 'Studio', hostname: 'studio.invalid' }] }, spaceObjectIcons: { 'project-source': 'code', 'mote-source': DEFAULT_MOTE_FACE } })
  await loaded(scene)
  const extent = [...boxes.values()], left = Math.min(...extent.map(box => box.x)), top = Math.min(...extent.map(box => box.y))
  await viewport(-left * .12 + 20, -top * .12 + 60, 1600, 1000, .12)
  const label = (id: string) => dom.container.querySelector<HTMLElement>(`[data-region-id="${id}"]`)!
  expect(dom.container.querySelectorAll('[data-region-id]'), 'Every original area identity remains readable at overview scale').toHaveLength(4)
  expect(label('area-0').querySelector('strong')?.textContent).toBe(name)
  expect(label('area-0').querySelector('[data-host-id="remote"]')?.textContent).toContain('Studio')
  expect(label('area-0').querySelector('[data-host-id="remote"]')?.getAttribute('data-host-kind')).toBe('ssh')
  expect(label('area-1').querySelector('[data-space-icon-kind="mote"]')).not.toBeNull()
  expect(label('area-1').querySelector('.collaboration-area__meta')?.textContent).toContain('Mote')
  expect(label('area-1').querySelector('.host-identity')).toBeNull()
  expect(label('area-2').querySelector('.collaboration-area__meta')?.textContent).toContain('Topic')
  expect(label('area-3').querySelector('[aria-label="Host: Host unknown"]')).not.toBeNull()
  expect(dom.container.querySelector('.collaboration-agent__dot .agent-avatar')).not.toBeNull()
  const geometry = captured.nodes.map(node => node.data.box), operations = requests.length
  await dom.render(graph({ ...scene, areas: scene.areas.map(area => area.id === 'area-0' ? { ...area, name: name + ' · 远程构建' } : area) }))
  expect(label('area-0').querySelector('strong')?.textContent).toBe(name + ' · 远程构建')
  expect(captured.nodes.map(node => node.data.box)).toEqual(geometry); expect(requests).toHaveLength(operations)
})
