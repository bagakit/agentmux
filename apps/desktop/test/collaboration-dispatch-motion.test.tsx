// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { installCollaborationCanvasGeometry } from './helpers/collaboration-canvas-dom'
import { installCollaborationLayoutLoopback, settleCollaborationCanvas } from './helpers/collaboration-layout-loopback'
import { CollaborationDispatchSignal, COLLABORATION_TRANSFER_MS } from '../src/renderer/src/components/CollaborationDispatchSignal'
import { AgentCollaborationGraph } from '../src/renderer/src/components/AgentCollaborationGraph'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { collaborationAgents, collaborationSubjectKey } from '../src/renderer/src/lib/agent-collaboration'
import { useCollaborationReading, type CollaborationPulse } from '../src/renderer/src/lib/use-collaboration-reading'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'

const dom = composerDOM({ agentInformation: true })
const sourcePath = 'M 0 0 L 100 0 Q 120 0 120 20 L 120 100'
beforeEach(() => {
  installCollaborationCanvasGeometry()
  installCollaborationLayoutLoopback()
  const config = useAppStore.getState().config!
  useAppStore.setState({ config: { ...config, focus: { ...config.focus, mapMotion: 'on' } } })
})
const signal = (pulseId = 1, startedAt = 9600, kind: 'communication' | 'supervision' = 'communication', zoom = 1) =>
  <svg><CollaborationDispatchSignal key={pulseId} pulseId={pulseId} startedAt={startedAt} path={sourcePath} length={800} zoom={zoom} kind={kind} /></svg>

it('draws one finite route-following head and tail without moving circles or filter effects', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(10000)
  await dom.render(signal())
  const tail = dom.container.querySelector<SVGPathElement>('.collaboration-edge__pulse')!
  const head = dom.container.querySelector<SVGPathElement>('.collaboration-edge__packet')!
  expect(tail).not.toBeNull(); expect(head).not.toBeNull()
  expect(dom.container.querySelectorAll('path')).toHaveLength(2)
  expect(dom.container.querySelector('circle, filter')).toBeNull()
  expect(head.getAttribute('d')).toBe(sourcePath)
  expect(tail.getAttribute('d')).toBe(sourcePath)
  expect(head.getAttribute('pathLength')).toBe('1')
  expect(head.style.animationDelay).toBe('-400ms')
  expect(head.style.getPropertyValue('--collaboration-transfer-duration')).toBe(`${COLLABORATION_TRANSFER_MS}ms`)
  expect(Number(head.style.getPropertyValue('--collaboration-transfer-span'))).toBeCloseTo(14 / 800)
  expect(Number(tail.style.getPropertyValue('--collaboration-transfer-span'))).toBeCloseTo(72 / 800)
})

it('keeps the original phase through unrelated renders and resumes only the remaining interval after remount', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(10000)
  await dom.render(signal())
  const original = dom.container.querySelector<SVGPathElement>('.collaboration-edge__packet')!
  clock.mockReturnValue(10300)
  await dom.render(signal(1, 9600, 'communication', 2))
  expect(dom.container.querySelector('.collaboration-edge__packet')).toBe(original)
  expect(original.style.animationDelay).toBe('-400ms')
  expect(Number(original.style.getPropertyValue('--collaboration-transfer-span'))).toBeCloseTo(14 / 1600)
  await dom.render(null)
  clock.mockReturnValue(10700)
  await dom.render(signal())
  expect(dom.container.querySelector<SVGPathElement>('.collaboration-edge__packet')!.style.animationDelay).toBe('-1100ms')
  await dom.render(null)
  clock.mockReturnValue(11300)
  await dom.render(signal())
  expect(dom.container.querySelector('.collaboration-edge__transfer')).toBeNull()
  await dom.render(signal(2, 11300))
  expect(dom.container.querySelector<SVGPathElement>('.collaboration-edge__packet')!.style.animationDelay).toBe('0ms')
})

it('keeps supervision as an observed route update rather than a new directed message', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(10000)
  await dom.render(signal(1, 9600, 'supervision'))
  expect(dom.container.querySelector('.collaboration-edge__packet')).toBeNull()
  expect(dom.container.querySelector('.collaboration-edge__update')?.getAttribute('d')).toBe(sourcePath)
})

const contexts = ['source', 'recipient'].map(id => agentContextForSession(composerSession(id), undefined, id, undefined, null))
const agents = collaborationAgents(contexts)
const members = contexts.map(context => collaborationSubjectKey({ hostId: 'local', agentSessionId: context.id }))
function graph(pulses: readonly CollaborationPulse[], active = true) {
  return <AgentCollaborationGraph agents={agents} areas={[{ id: 'original-project', kind: 'project', name: 'Original project', members }]}
    relations={[{ id: 'original-message', kind: 'communication', source: members[0]!, target: members[1]!, evidence: [] }]}
    pulses={pulses} selection={null} onSelect={vi.fn()} onOpen={vi.fn()} active={active} />
}

it('connects the actual Graph clipped route and endpoint observation without text badges or delivery claims', async () => {
  const pulses: CollaborationPulse[] = [{ id: 1, startedAt: Date.now(), hostId: 'local', sender: 'source', recipient: 'recipient', kind: 'communication' }]
  await dom.render(graph(pulses))
  await settleCollaborationCanvas(() => expect(dom.container.querySelector('.collaboration-edge__packet')).not.toBeNull())
  const route = dom.container.querySelector('.react-flow__edge-path')!
  expect(dom.container.querySelector('.collaboration-edge__packet')?.getAttribute('d')).toBe(route.getAttribute('d'))
  expect(dom.container.querySelectorAll('.collaboration-activity')).toHaveLength(2)
  expect(dom.container.querySelector('[data-direction=sent]')?.getAttribute('aria-label')).toContain('source')
  expect(dom.container.querySelector('[data-direction=received]')?.getAttribute('aria-label')).toContain('destination')
  expect([...dom.container.querySelectorAll('.collaboration-activity')].every(element => element.textContent === '')).toBe(true)
  expect(dom.container.textContent).not.toMatch(/Sent ↗|Received ↙/)
  const config = useAppStore.getState().config!
  await act(async () => useAppStore.setState({ config: { ...config, focus: { ...config.focus, mapMotion: 'off' } } }))
  expect(dom.container.querySelector('.collaboration-edge__packet')).toBeNull()
  await dom.render(graph(pulses, false))
  expect(dom.container.querySelector('.collaboration-edge__packet')).toBeNull()
})

it('retains static recent observation after the shorter flow has ended and honors the original off preference', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(12000)
  const pulses: CollaborationPulse[] = [{ id: 1, startedAt: 10000, hostId: 'local', sender: 'source', recipient: 'recipient', kind: 'communication' }]
  await dom.render(graph(pulses))
  await settleCollaborationCanvas(() => expect(dom.container.querySelector('.react-flow__edge[data-recent=true]')).not.toBeNull())
  expect(dom.container.querySelector('.collaboration-edge__packet')).toBeNull()
  expect(dom.container.querySelectorAll('.collaboration-activity')).toHaveLength(2)
  const config = useAppStore.getState().config!
  await act(async () => useAppStore.setState({ config: { ...config, focus: { ...config.focus, mapMotion: 'off' } } }))
  expect(dom.container.querySelector('.collaboration-canvas')?.getAttribute('data-motion')).toBe('off')
  expect(dom.container.querySelector('.collaboration-edge__packet')).toBeNull()
  expect(dom.container.querySelectorAll('.collaboration-activity')).toHaveLength(2)
})

it('consumes only new live events for the accurate Host subjects and clears feedback when hidden', async () => {
  const listeners = new Set<Parameters<typeof api.sessions.onEvent>[0]>()
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(listener => { listeners.add(listener); return () => { listeners.delete(listener) } })
  const scope = { current: new Set(members) }
  function Reader({ enabled }: { enabled: boolean }) {
    const reading = useCollaborationReading([], enabled, scope)
    return graph(reading.pulses, enabled)
  }
  await dom.render(<Reader enabled />)
  await settleCollaborationCanvas(() => expect(dom.container.querySelector('.react-flow__edge-path')).not.toBeNull())
  const event = (sequence: number, hostId = 'local', live = true) => ({ hostId, event: { type: 'agent-message-changed', recordKind: 'message', sequence, live, senderSessionId: 'source', recipientSessionId: 'recipient' } }) as Parameters<Parameters<typeof api.sessions.onEvent>[0]>[0]
  const emit = async (value: ReturnType<typeof event>) => act(async () => { for (const listener of listeners) listener(value) })
  await emit(event(1, 'another-host'))
  await emit(event(1, 'local', false))
  expect(dom.container.querySelector('.collaboration-edge__packet')).toBeNull()
  await emit(event(1))
  expect(dom.container.querySelector('.collaboration-edge__packet')).not.toBeNull()
  const original = dom.container.querySelector('.collaboration-edge__packet')
  await emit(event(1))
  expect(dom.container.querySelector('.collaboration-edge__packet')).toBe(original)
  await dom.render(<Reader enabled={false} />)
  expect(dom.container.querySelector('.collaboration-edge__packet')).toBeNull()
  await dom.render(<Reader enabled />)
  expect(dom.container.querySelector('.collaboration-edge__packet')).toBeNull()
})
