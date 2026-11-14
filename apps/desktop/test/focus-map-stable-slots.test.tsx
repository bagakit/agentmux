// @vitest-environment happy-dom
import { act, useLayoutEffect, type ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { Node, ReactFlowProps, useStoreApi } from '@xyflow/react'
import { AgentCollaborationGraph } from '../src/renderer/src/components/AgentCollaborationGraph'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { collaborationAgents, type CollaborationAgent, type CollaborationArea } from '../src/renderer/src/lib/agent-collaboration'
import { collaborationAgentNode } from '../src/renderer/src/lib/collaboration-presentation'
import { agentInformationPreview } from '../src/renderer/src/lib/agent-information-preview'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { installCollaborationCanvasGeometry } from './helpers/collaboration-canvas-dom'
import { installCollaborationLayoutLoopback, settleCollaborationCanvas } from './helpers/collaboration-layout-loopback'
import type { CollaborationLayoutRequest, CollaborationLayoutBox } from '../src/renderer/src/lib/collaboration-layout-engine'

const captured = vi.hoisted(() => ({ nodes: [] as Node[], store: null as ReturnType<typeof useStoreApi> | null }))
vi.mock('@xyflow/react', async importOriginal => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()
  function ObserveStore() {
    const store = actual.useStoreApi()
    useLayoutEffect(() => { captured.store = store }, [store]); return null
  }
  return { ...actual, ReactFlow: ({ children, ...props }: ReactFlowProps & { children?: ReactNode }) => {
    captured.nodes = props.nodes ?? []
    return <actual.ReactFlow {...props}>{children}<ObserveStore /></actual.ReactFlow>
  } }
})
const dom = composerDOM({ agentInformation: true }), selected = vi.fn(), opened = vi.fn()
let requests: CollaborationLayoutRequest[]
beforeEach(() => {
  installCollaborationCanvasGeometry(1200, 800)
  captured.nodes = []; captured.store = null; selected.mockReset(); opened.mockReset()
  requests = installCollaborationLayoutLoopback()
  const config = useAppStore.getState().config!
  useAppStore.setState({ config: { ...config, focus: { ...config.focus, mapMotion: 'off' } } })
})
function scene() {
  const at = Date.now() - 72 * 3_600_000
  const contexts = ['working', 'quiet', 'unconfirmed'].map(id => agentContextForSession(composerSession(id), undefined, `Original ${id}`, undefined, null))
  const agents = collaborationAgents(contexts)
  for (const [id, agent] of agents) agents.set(id, { ...agent, tier: agent.sessionId === 'working' ? 'active' : agent.sessionId === 'quiet' ? 'idle' : 'unknown', lastActivityAt: at })
  const ids = [...agents.keys()]
  const areas: CollaborationArea[] = [
    { id: 'project', name: 'Original project', kind: 'project', members: ids },
    { id: 'second-occurrence', name: 'Another presentation', kind: 'project', members: [ids[1]!] }
  ]
  return { agents, areas, ids }
}
function graph(agents: ReadonlyMap<string, CollaborationAgent>, areas: readonly CollaborationArea[], visible = vi.fn()) {
  return <AgentCollaborationGraph agents={agents} areas={areas} relations={[]} pulses={[]} selection={null}
    onSelect={selected} onOpen={opened} ready={false} onVisibleAgents={visible} />
}
const box = (id: string) => captured.nodes.find(node => node.id === id)!.data.box as CollaborationLayoutBox
const element = (id: string) => [...dom.container.querySelectorAll<HTMLElement>('.react-flow__node')].find(node => node.dataset.id === id)!
async function settled(count: number) {
  await settleCollaborationCanvas(() => {
    expect(captured.nodes).toHaveLength(count)
    expect(dom.container.querySelector('.collaboration-canvas__progress')).toBeNull()
    expect(dom.container.querySelector('.collaboration-canvas__issue')).toBeNull()
  })
}
async function showAll() {
  const bounds = captured.nodes.map(node => box(node.id))
  await act(async () => captured.store!.setState({ width: 20_000, height: 20_000,
    transform: [-Math.min(...bounds.map(value => value.x)) + 20, -Math.min(...bounds.map(value => value.y)) + 20, 1] }))
}
async function waitForNoAutomaticPlacement() {
  // Cross the original 100ms Worker dispatch window before asserting no job.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)) })
}

it('keeps exact occurrence slots and camera through live state changes while compact active members use the original Reader', async () => {
  const { agents, areas, ids } = scene(), visible = vi.fn()
  await dom.render(graph(agents, areas, visible)); await settled(6); await showAll()
  const workingId = collaborationAgentNode('project', ids[0]!), quietId = collaborationAgentNode('project', ids[1]!)
  expect(box(workingId)).toMatchObject({ width: 250, height: 94 })
  expect(box(quietId)).toMatchObject({ width: 24, height: 24 })
  const original = new Map(captured.nodes.map(node => [node.id, box(node.id)])), camera = captured.store!.getState().transform
  const workingCard = element(workingId).querySelector('.focus-context')
  expect(workingCard).not.toBeNull()
  const changed = new Map(agents)
  changed.set(ids[0]!, { ...agents.get(ids[0]!)!, tier: 'idle' })
  changed.set(ids[1]!, { ...agents.get(ids[1]!)!, tier: 'active', lastActivityAt: Date.now() })
  await dom.render(graph(changed, areas, visible)); await waitForNoAutomaticPlacement()
  expect(requests.map(request => request.type)).toEqual(['arrange'])
  for (const node of captured.nodes) expect(box(node.id)).toBe(original.get(node.id))
  expect(captured.store!.getState().transform).toBe(camera)
  expect(element(workingId).querySelector('.focus-context')).toBe(workingCard)
  expect(element(quietId).querySelector('.focus-context')).toBeNull()
  expect(element(quietId).querySelector('.collaboration-agent__point')).not.toBeNull()
  const mark = element(quietId).querySelector<HTMLButtonElement>('.collaboration-agent__dot')!
  expect(mark.getAttribute('aria-label')).toContain('active')
  await act(async () => { mark.focus(); mark.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  expect(agentInformationPreview.getAll().map(request => [request.context.id, request.anchor])).toEqual([['quiet', mark]])
  expect(opened).not.toHaveBeenCalled(); expect(selected).not.toHaveBeenCalled()
  expect(visible.mock.calls.at(-1)?.[0] ?? []).not.toContain(ids[1])
  changed.set(ids[1]!, { ...changed.get(ids[1]!)!, tier: 'unknown' })
  await dom.render(graph(new Map(changed), areas, visible)); await waitForNoAutomaticPlacement()
  expect(element(quietId).querySelector('.collaboration-agent--unknown')).not.toBeNull()
  for (const node of captured.nodes) expect(box(node.id)).toBe(original.get(node.id))
  expect(requests).toHaveLength(1)
})

it('resizes known quiet and active slots only on explicit Arrange and preserves full unknown membership', async () => {
  const { agents, areas, ids } = scene()
  await dom.render(graph(agents, areas)); await settled(6); await showAll()
  const quietId = collaborationAgentNode('project', ids[1]!), workingId = collaborationAgentNode('project', ids[0]!)
  const unknownId = collaborationAgentNode('project', ids[2]!)
  const changed = new Map(agents)
  changed.set(ids[0]!, { ...agents.get(ids[0]!)!, tier: 'idle' })
  changed.set(ids[1]!, { ...agents.get(ids[1]!)!, tier: 'active' })
  await dom.render(graph(changed, areas)); await waitForNoAutomaticPlacement()
  expect(box(workingId).width).toBe(250); expect(box(quietId).width).toBe(24)
  const camera = captured.store!.getState().transform
  expect(dom.container.querySelector('[aria-label="Arrange map"]')?.getAttribute('title')).toContain('Positions stay fixed')
  await dom.click('[aria-label="Arrange map"]'); await settled(6)
  await settleCollaborationCanvas(() => expect(box(workingId).width).toBe(24))
  expect(box(quietId)).toMatchObject({ width: 250, height: 94 })
  expect(box(unknownId)).toMatchObject({ width: 154, height: 38 })
  expect(box(collaborationAgentNode('second-occurrence', ids[1]!))).toMatchObject({ width: 250, height: 94 })
  expect(requests.map(request => request.type)).toEqual(['arrange', 'arrange'])
  expect(captured.store!.getState().transform).toBe(camera)
})

it('does not treat missing activity time or unknown observation as a cold closed slot', async () => {
  const { agents, areas, ids } = scene()
  agents.set(ids[1]!, { ...agents.get(ids[1]!)!, lastActivityAt: null })
  await dom.render(graph(agents, areas)); await settled(6)
  for (const id of [ids[1]!, ids[2]!]) expect(box(collaborationAgentNode('project', id))).toMatchObject({ width: 154, height: 38 })
  await dom.click('[aria-label="Arrange map"]')
  await settleCollaborationCanvas(() => expect(requests).toHaveLength(2))
  for (const id of [ids[1]!, ids[2]!]) expect(box(collaborationAgentNode('project', id))).toMatchObject({ width: 154, height: 38 })
  expect(opened).not.toHaveBeenCalled()
})

it('admits new occurrences and keeps original Worker reconciliation for folding and true membership changes', async () => {
  const { agents, areas, ids } = scene()
  await dom.render(graph(agents, areas)); await settled(6); await showAll()
  const context = agentContextForSession(composerSession('new-exact-member'), undefined, 'New exact member', undefined, null)
  const fresh: CollaborationAgent = { ...collaborationAgents([context]).values().next().value!, tier: 'active', lastActivityAt: Date.now() }
  const nextAgents = new Map([...agents, [fresh.id, fresh]])
  const added = areas.map(area => area.id === 'project' ? { ...area, members: [...area.members, fresh.id] } : area)
  await dom.render(graph(nextAgents, added)); await settled(7)
  expect(requests.map(request => request.type)).toEqual(['arrange', 'reconcile'])
  expect(box(collaborationAgentNode('project', fresh.id))).toMatchObject({ width: 250, height: 94 })
  const fold = dom.container.querySelector<HTMLButtonElement>('[aria-label="Collapse Original project"]')
  expect(fold).not.toBeNull()
  await act(async () => fold!.click()); await settled(3)
  expect(requests.at(-1)?.type).toBe('reconcile')
  const expand = dom.container.querySelector<HTMLButtonElement>('[aria-label="Expand Original project"]')
  expect(expand).not.toBeNull()
  await act(async () => expand!.click()); await settled(7)
  const moved = added.map(area => ({ ...area, members: area.id === 'project' ? area.members.filter(id => id !== fresh.id) : [...area.members, fresh.id] }))
  await dom.render(graph(nextAgents, moved)); await settled(7)
  expect(captured.nodes.some(node => node.id === collaborationAgentNode('project', fresh.id))).toBe(false)
  expect(box(collaborationAgentNode('second-occurrence', fresh.id))).toBeDefined()
  expect(dom.draft()).toBe('Keep my draft'); expect(opened).not.toHaveBeenCalled()
})
