// @vitest-environment happy-dom
import { act, useLayoutEffect, type ComponentProps, type ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { Node, ReactFlowProps, useStoreApi } from '@xyflow/react'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { installCollaborationCanvasGeometry } from './helpers/collaboration-canvas-dom'
import { AgentCollaborationGraph, type CollaborationSelection } from '../src/renderer/src/components/AgentCollaborationGraph'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { collaborationAgents, collaborationSubjectKey, type CollaborationArea, type CollaborationRelation } from '../src/renderer/src/lib/agent-collaboration'
import { collaborationAgentNode } from '../src/renderer/src/lib/collaboration-presentation'
import * as routing from '../src/renderer/src/lib/collaboration-routing'
import type { CollaborationPulse } from '../src/renderer/src/lib/use-collaboration-reading'
const captured = vi.hoisted(() => ({ nodes: [] as Node[], store: null as ReturnType<typeof useStoreApi> | null, cardRenders: [] as string[] }))
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
    return <actual.ReactFlow {...props}>{children}<ObserveOriginalStore /></actual.ReactFlow>
  } }
})
const dom = composerDOM({ agentInformation: true }), select = vi.fn(), open = vi.fn()
const subject = (id: string) => collaborationSubjectKey({ hostId: 'local', agentSessionId: id })
const contexts = Array.from({ length: 480 }, (_, i) => agentContextForSession(composerSession(`canvas-${i}`), undefined, `Agent ${i}`))
const agents = collaborationAgents(contexts)
const areas: CollaborationArea[] = [
  { id: 'left', kind: 'project', name: 'Project', members: contexts.slice(0, 240).map(context => subject(context.id)) },
  { id: 'right', kind: 'topic', name: 'Topic', members: contexts.slice(240).map(context => subject(context.id)) },
  { id: 'lower', kind: 'mote', name: 'Mote', members: [subject('canvas-extra')] }
]
agents.set(subject('canvas-extra'), { id: subject('canvas-extra'), subject: { hostId: 'local', agentSessionId: 'canvas-extra' }, sessionId: 'canvas-extra' })
const relation: CollaborationRelation = { id: 'original-relation', kind: 'communication', source: subject('canvas-0'), target: subject('canvas-extra'), evidence: [] }
function graph(selection: CollaborationSelection = null, relations: readonly CollaborationRelation[] = [relation], pulses: readonly CollaborationPulse[] = []) {
  return <AgentCollaborationGraph agents={agents} areas={areas} relations={relations} pulses={pulses} selection={selection} onSelect={select} onOpen={open} ready={false} />
}
async function viewport(x = 0, y = 0, width = 600, height = 400) {
  await act(async () => captured.store!.setState({ width, height, transform: [x, y, 1] }))
}
beforeEach(() => {
  installCollaborationCanvasGeometry(600, 400); captured.store = null; captured.nodes = []; captured.cardRenders = []; select.mockReset(); open.mockReset()
  vi.spyOn(routing, 'routeCollaboration')
})

it('the actual Graph and original xyflow mount only visible production cards from a large fixed world', async () => {
  await dom.render(graph()); expect(captured.store).not.toBeNull(); await viewport()
  await act(async () => vi.waitFor(() => expect(dom.container.querySelectorAll('.collaboration-agent').length).toBeGreaterThan(0)))
  const cards = dom.container.querySelectorAll('.collaboration-agent')
  expect(captured.nodes.length).toBeGreaterThan(480); expect(cards.length).toBeLessThan(12)
  // Count every real body ever rendered, so a transient full initial mount followed by culling cannot pass.
  expect(new Set(captured.cardRenders).size).toBeGreaterThan(0)
  expect(new Set(captured.cardRenders).size).toBeLessThan(12)
  expect(dom.container.querySelector('.focus-context[data-session-id="canvas-0"]')).not.toBeNull()
  const internal = captured.store!.getState().nodeLookup
  expect([...internal.values()].filter(node => !node.internals.handleBounds)).toHaveLength(0)
  expect(dom.container.querySelectorAll('.react-flow__handle')).toHaveLength(0)
})

it('keeps unrelated whole node and geometry references through selection and metadata-only relation updates', async () => {
  await dom.render(graph()); await viewport()
  const before = new Map(captured.nodes.map(node => [node.id, node])), camera = captured.store!.getState().transform
  const routed = vi.mocked(routing.routeCollaboration).mock.calls.length
  expect(routed).toBeGreaterThan(0)
  await dom.render(graph({ kind: 'agent', id: subject('canvas-0') }))
  const changed = captured.nodes.filter(node => node !== before.get(node.id))
  expect(changed.map(node => node.id)).toEqual([collaborationAgentNode('left', subject('canvas-0'))])
  const selected = new Map(captured.nodes.map(node => [node.id, node]))
  const bodies = captured.cardRenders.length
  await dom.render(graph({ kind: 'agent', id: subject('canvas-0') }, [{ ...relation, evidence: [...relation.evidence] }]))
  expect(captured.nodes.every(node => node === selected.get(node.id))).toBe(true)
  expect(captured.cardRenders).toHaveLength(bodies)
  expect(routing.routeCollaboration).toHaveBeenCalledTimes(routed)
  expect(captured.store!.getState().transform).toBe(camera)
  expect(dom.container.querySelectorAll('.collaboration-agent').length).toBeLessThan(12)
})

it('renders and selects a real corridor detour while both original endpoint cards are offscreen', async () => {
  await dom.render(graph()); await viewport(-590, -240, 30, 200)
  expect(dom.container.querySelectorAll('.collaboration-agent')).toHaveLength(0)
  const edge = dom.container.querySelector<SVGGElement>('.collaboration-connections .react-flow__edge')
  expect(edge).not.toBeNull(); expect(edge!.querySelector('.react-flow__edge-interaction')?.getAttribute('stroke-width')).toBe('22')
  const marker = edge!.querySelector('.react-flow__edge-path')!.getAttribute('marker-end')!
  const markerReference = /^url\(#(.+)\)$/.exec(marker)
  expect(markerReference).not.toBeNull()
  expect(document.getElementById(markerReference![1]!)?.localName).toBe('marker')
  expect(edge!.getAttribute('role')).toBe('button'); expect(edge!.getAttribute('tabindex')).toBe('0')
  await act(async () => edge!.querySelector('.react-flow__edge-interaction')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(select).toHaveBeenLastCalledWith({ kind: 'relation', id: relation.id, relatedIds: [relation.id] })
  for (const key of ['Enter', ' ']) {
    select.mockClear()
    const input = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    await act(async () => edge!.dispatchEvent(input))
    expect(input.defaultPrevented).toBe(true); expect(select).toHaveBeenCalledTimes(1)
    expect(select).toHaveBeenLastCalledWith({ kind: 'relation', id: relation.id, relatedIds: [relation.id] })
  }
  select.mockClear()
  await act(async () => edge!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(select).toHaveBeenCalledTimes(1)
  expect(select).toHaveBeenLastCalledWith(null); expect(open).not.toHaveBeenCalled()
})

it('keeps an original pulse phase through selection and resumes only its elapsed phase after viewport remount', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(10000)
  const pulses: CollaborationPulse[] = [{ id: 1, startedAt: 9600, hostId: 'local', sender: 'canvas-0', recipient: 'canvas-extra', kind: 'communication' }]
  await dom.render(graph(null, [relation], pulses)); await viewport(-590, -240, 30, 200)
  const pulse = dom.container.querySelector<SVGPathElement>('.collaboration-edge__pulse')!
  expect(pulse).not.toBeNull(); expect(pulse.style.animationDelay).toBe('-400ms')
  clock.mockReturnValue(10300)
  await dom.render(graph({ kind: 'relation', id: relation.id }, [relation], pulses))
  expect(dom.container.querySelector('.collaboration-edge__pulse')).toBe(pulse)
  expect(pulse.style.animationDelay).toBe('-400ms')
  await viewport(-2000, -240, 30, 200)
  expect(dom.container.querySelector('.collaboration-edge__pulse')).toBeNull()
  clock.mockReturnValue(10700)
  await viewport(-590, -240, 30, 200)
  const resumed = dom.container.querySelector<SVGPathElement>('.collaboration-edge__pulse')!
  expect(resumed).not.toBeNull(); expect(resumed).not.toBe(pulse)
  expect(resumed.style.animationDelay).toBe('-1100ms')
})
