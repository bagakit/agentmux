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
import * as engine from '../src/renderer/src/lib/collaboration-layout-engine'
import type { CollaborationPulse } from '../src/renderer/src/lib/use-collaboration-reading'
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
function graph(scene: Scene, selection: CollaborationSelection = null, relations: readonly CollaborationRelation[] = scene.relations, pulses: readonly CollaborationPulse[] = [], agents: ReadonlyMap<string, CollaborationAgent> = scene.agents, options: Pick<ComponentProps<typeof AgentCollaborationGraph>, 'ready' | 'locate' | 'onPreviewAgent'> = {}) {
  return <AgentCollaborationGraph agents={agents} areas={scene.areas} relations={relations} pulses={pulses} selection={selection} onSelect={select} onOpen={open} ready={false} {...options} />
}
async function viewport(x: number, y: number, width = 600, height = 400, zoom = 1) {
  await act(async () => captured.store!.setState({ width, height, transform: [x, y, zoom] }))
}
async function loaded(scene: Scene) {
  await dom.render(graph(scene))
  await settleCollaborationCanvas(() => {
    expect(captured.nodes).toHaveLength(scene.areas.reduce((sum, area) => sum + area.members.length + 1, 0))
    expect(dom.container.querySelector('.collaboration-canvas__progress')).toBeNull()
    expect(dom.container.querySelector('.collaboration-canvas__issue')).toBeNull()
    expect(paths.size).toBeGreaterThan(0)
  })
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
/** Read the real curve and original Worker boxes; never prescribe a layout or substitute a route. */
function detour() {
  const input = requests.find(request => request.type === 'arrange')!
  expect(input.type).toBe('arrange')
  if (input.type !== 'arrange') throw Error('Expected original arrangement request')
  for (const connection of input.input.connections) {
    const route = paths.get(connection.id)!, points = curvePoints(route.path), from = boxes.get(connection.source)!, to = boxes.get(connection.target)!
    const first = points[0]!, last = points.at(-1)!, left = Math.min(first.x, last.x), right = Math.max(first.x, last.x), top = Math.min(first.y, last.y), bottom = Math.max(first.y, last.y)
    for (let segment = 0; segment < points.length - 1; segment += 3) for (let sample = 1; sample < 100; sample++) {
      const p = points.slice(segment, segment + 4), t = sample / 100, u = 1 - t
      const x = u ** 3 * p[0]!.x + 3 * u ** 2 * t * p[1]!.x + 3 * u * t ** 2 * p[2]!.x + t ** 3 * p[3]!.x
      const y = u ** 3 * p[0]!.y + 3 * u ** 2 * t * p[1]!.y + 3 * u * t ** 2 * p[2]!.y + t ** 3 * p[3]!.y
      if ((x < left - 42 || x > right + 42 || y < top - 42 || y > bottom + 42) && !boxIntersects(from, x - 4, y - 4, 8) && !boxIntersects(to, x - 4, y - 4, 8)) return { connection, route, x, y }
    }
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

it('renders and selects an actual Worker detour while both original endpoint cards are offscreen', async () => {
  const scene = scenario(24); await loaded(scene)
  const candidate = detour(); expect(candidate, 'The actual force scene must contain a curve outside the endpoint rectangle').toBeDefined()
  const { connection, route, x, y } = candidate!
  await viewport(-x + 4, -y + 4, 8, 8)
  for (const id of [connection.source, connection.target]) expect([...dom.container.querySelectorAll('.react-flow__node')].some(element => element.getAttribute('data-id') === id)).toBe(false)
  const edge = edgeElement(connection.id); expect(edge).toBeDefined()
  expect(edge!.querySelector('.react-flow__edge-path')!.getAttribute('d')).toBe(route.path)
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
  const scene = scenario(24); await loaded(scene)
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
    const heading = node!.querySelector<HTMLButtonElement>('.collaboration-area__heading')!
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

it('anchors the clicked exact occurrence through a real size transition and translates every original curve consistently', async () => {
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
  expect(Math.abs(offset.x) + Math.abs(offset.y)).toBeGreaterThan(.1)
  expect(Math.abs(previous.get(first)!.x - placed.get(first)!.x - offset.x) + Math.abs(previous.get(first)!.y - placed.get(first)!.y - offset.y)).toBeGreaterThan(.1)
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
    expect(curve).toHaveLength(rawPath.points.length)
    for (const [index, point] of curve.entries()) { expect(point.x).toBeCloseTo(rawPath.points[index]!.x + offset.x, 8); expect(point.y).toBeCloseTo(rawPath.points[index]!.y + offset.y, 8) }
    const translated = engine.translateCollaborationPath(rawPath, offset)
    expect(translated.points).toEqual(curve)
    expect(translated.id).toBe(rawPath.id); expect(translated.sourceHandle).toBe(rawPath.sourceHandle); expect(translated.targetHandle).toBe(rawPath.targetHandle)
    expect(translated.bounds).toEqual({ ...rawPath.bounds, x: rawPath.bounds.x + offset.x, y: rawPath.bounds.y + offset.y })
    expect([translated.labelX, translated.labelY]).toEqual([rawPath.labelX + offset.x, rawPath.labelY + offset.y])
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
  expect(captured.store!.getState().transform).toBe(camera); expect(requests.map(request => request.type)).toEqual(['arrange', 'arrange', 'arrange'])
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
  holdResponses = true
  await act(async () => nodeElement(areaId)!.querySelector<HTMLButtonElement>('.collaboration-area__heading')!.click())
  await settleCollaborationCanvas(() => expect(heldResponses.some(item => item.response.type === 'complete')).toBe(true))
  await releasePlacement()
  expect(captured.nodes.some(node => node.id === reading)).toBe(false)
  expect(headingAt().x).toBeCloseTo(heading.x, 8); expect(headingAt().y).toBeCloseTo(heading.y, 8)
  expect(captured.store!.getState().transform).toBe(camera)
  expect(nodeElement(areaId)!.querySelector('.collaboration-area__heading')).not.toBeNull()
  await act(async () => nodeElement(areaId)!.querySelector<HTMLButtonElement>('.collaboration-area__heading')!.click())
  await settleCollaborationCanvas(() => { expect(captured.nodes.some(node => node.id === reading)).toBe(true); expect(dom.container.querySelector('.collaboration-canvas__progress')).toBeNull() })
  const resized = new Map(changed); resized.set(subject('canvas-8'), { ...resized.get(subject('canvas-8'))!, tier: 'closed' })
  await dom.render(graph(scene, null, scene.relations, [], resized, { ready: true, locate }))
  await settleCollaborationCanvas(() => { expect(requests).toHaveLength(5); expect(dom.container.querySelector('.collaboration-canvas__progress')).toBeNull() })
  // The explicitly read heading remains the anchor; a reappearing Agent is not a new reading intent.
  expect(headingAt().x).toBeCloseTo(heading.x, 8); expect(headingAt().y).toBeCloseTo(heading.y, 8)
  expect(captured.store!.getState().transform).toBe(camera)
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
  expect(Math.hypot(ends[0]!.x - source.x - source.width / 2, ends[0]!.y - source.y - source.height / 2)).toBeCloseTo(24)
  expect(Math.hypot(ends.at(-1)!.x - target.x - target.width / 2, ends.at(-1)!.y - target.y - target.height / 2)).toBeCloseTo(24)
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
  // The node's screen-sized heading stays within its original area; miniature labels cannot overlap shelves.
  const heading = dom.container.querySelector<HTMLButtonElement>('[aria-label="Locate Original area 0 · 6 Agents"]')!
  expect(heading).not.toBeNull()
  expect(heading.textContent).toContain('Original area 0')
  expect(heading.textContent).toContain('6 Agents')
  const area = heading.closest<HTMLElement>('.collaboration-area')!
  const areaBox = renderedBox(JSON.stringify(['area', 'area-0']))
  expect(areaBox.kind).toBe('area')
  expect(Number.parseFloat(area.style.getPropertyValue('--collaboration-label-width'))).toBeCloseTo(Math.min(240, (areaBox.width - (areaBox as Extract<engine.CollaborationLayoutBox, { kind: 'area' }>).heading.x) * .25))
  await dom.render(graph(scene, null, scene.relations, [], scene.agents, { ready: true }))
  // Locate is an explicit control intent, so it is allowed to replace this already-set camera.
  await viewport(-left * .25 + 20, -top * .25 + 20, 1600, 1200, .25)
  await act(async () => heading.click())
  await settleCollaborationCanvas(() => expect(captured.store!.getState().transform[2]).toBeGreaterThanOrEqual(.7))
  expect(requests).toHaveLength(operations)
  expect(open).not.toHaveBeenCalled()
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
    await act(async () => nodeElement(JSON.stringify(['area', area.id]))!.querySelector<HTMLButtonElement>('.collaboration-area__heading')!.click())
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
    await act(async () => nodeElement(JSON.stringify(['area', area.id]))!.querySelector<HTMLButtonElement>('.collaboration-area__heading')!.click())
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
