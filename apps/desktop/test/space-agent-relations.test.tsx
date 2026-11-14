// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMuxMessageEvent, AgentSessionHistoryDescriptor } from '@agentmux/core'
import { createWorkspaceLayout } from '@agentmux/layout'
import { SurfaceToolDock } from '../src/renderer/src/components/SurfaceToolDock'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { workspaceAgentGroups } from '../src/renderer/src/lib/workspace-agent-arrangement'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

vi.mock('../src/renderer/src/components/WorkspaceFilesTool', () => ({ WorkspaceFilesTool: () => null }))
vi.mock('../src/renderer/src/components/WorkspaceGitTool', () => ({ WorkspaceGitTool: () => null }))
const dom = composerDOM(), workspace = composerConfig.workspaces[0]!
const key = (id: string, host = 'local') => JSON.stringify([host, id])
const parent = (id: string) => ({ createOperationId: `create-${id}`, initialPrompt: 'confirmed' as const,
  createdBy: { agentSessionId: id, run: { runId: `original-${id}` }, owner: { kind: 'local' as const } } })
const agent = (id: string, createdAt: number, from?: string) => ({ ...composerSession(id), label: id, createdAt,
  ...(from ? { creation: parent(from) } : {}) })
const retired: AgentSessionHistoryDescriptor = { hostId: 'local', agentSessionId: 'retired', state: 'retired', retiredAt: 100,
  history: { providerId: 'codex', executorId: 'codex', workspacePath: workspace.path, createdAt: 5,
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'native-retired' } } }
const message: AgentMuxMessageEvent = { sequence: 1, kind: 'message', at: 1, messages: [{ messageId: 'original-message', senderSessionId: 'root', recipientSessionId: 'peer', threadId: 'thread', replyTo: null }] }
const page = (id: string, events: readonly AgentMuxMessageEvent[] = []) => ({ hostId: 'local', participantSessionId: id, afterSequence: 0, latest: true,
  beforeSequence: null, throughSequence: 1, incarnation: 'original-journal', messageId: null, broadcastOperationId: null, events, nextAfterSequence: null, nextBeforeSequence: null })
const ids = () => [...dom.container.querySelectorAll<HTMLElement>('.workspace-agent-list-item')].map(node => JSON.parse(node.dataset.agentKey!)[1])
const render = () => dom.render(<SurfaceToolDock workspace={workspace} />)
async function closed() { await act(async () => dom.container.querySelector<HTMLInputElement>('.workspace-agents-tool__closed input')!.click()) }
function button(label: string) { return [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === label)! }
beforeEach(() => {
  const tab = createWorkbenchTab('original-tab', { kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: 'root', regionId: 'original-region' })
  useAppStore.setState({ config: composerConfig, sessions: [agent('root', 10), agent('unrelated', 20), agent('child', 30, 'root'), agent('grandchild', 40, 'child')],
    tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('original-group', [tab.id]) }, activeWorkspaceId: workspace.id,
    mainSurface: 'workbench', workspaceTool: 'agents', workbenchSpaceSelection: null, workspaceAgentOrder: {}, timelines: {}, agentNames: {}, demands: {},
    scratchTopicSnapshots: {}, agentComposerDrafts: { root: 'original unsent draft' }, error: null })
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue({ sources: [], warnings: [] })
  vi.spyOn(api.sessions, 'messageEvents').mockImplementation(async subject => page(subject.agentSessionId))
})

describe('Space derivation groups through the actual Dock and ordering owner', () => {
  it('keeps descendants adjacent with one move target and normalizes a public child move to the complete tree', async () => {
    await render()
    expect(ids()).toEqual(['root', 'child', 'grandchild', 'unrelated'])
    expect([...dom.container.querySelectorAll<HTMLElement>('[data-agent-depth]')].map(node => node.dataset.agentDepth)).toEqual(['0', '1', '2', '0'])
    expect(dom.container.querySelectorAll('.workspace-agent-list-item__drag')).toHaveLength(2)
    const before = useAppStore.getState(), protectedFacts = [before.tabs, before.layouts, before.agentComposerDrafts]
    vi.mocked(api.sessions.historySources).mockClear(); vi.mocked(api.sessions.messageEvents).mockClear()
    await act(async () => { await useAppStore.getState().setWorkspaceAgentOrder(workspace.id, [key('unrelated'), key('child')]) })
    expect(api.sessions.historySources).not.toHaveBeenCalled(); expect(api.sessions.messageEvents).not.toHaveBeenCalled()
    expect(ids()).toEqual(['unrelated', 'root', 'child', 'grandchild'])
    expect(useAppStore.getState().workspaceAgentOrder[workspace.id]).toEqual(['unrelated', 'root', 'child', 'grandchild'].map(id => key(id)))
    expect([useAppStore.getState().tabs, useAppStore.getState().layouts, useAppStore.getState().agentComposerDrafts]).toEqual(protectedFacts)
  })
  it('puts observed communicating groups nearby, keeps manual groups pinned and never reads unrelated members', async () => {
    useAppStore.setState(state => ({ sessions: [agent('root', 10), agent('unrelated', 20), agent('peer', 30), agent('foreign', 1)].map(session => session.id === 'foreign' ? { ...session, workspacePath: '/other' } : session) }))
    vi.mocked(api.sessions.messageEvents).mockImplementation(async subject => page(subject.agentSessionId, subject.agentSessionId === 'root' ? [message] : []))
    await render()
    expect(ids()).toEqual(['root', 'peer', 'unrelated'])
    expect(vi.mocked(api.sessions.messageEvents).mock.calls.every(([subject]) => subject.agentSessionId !== 'foreign')).toBe(true)
    await act(async () => useAppStore.setState({ workspaceAgentOrder: { [workspace.id]: ['unrelated', 'root', 'peer'].map(id => key(id)) } }))
    expect(ids()).toEqual(['unrelated', 'root', 'peer'])
    await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => ({ ...session, updatedAt: Math.random() * 10000 })) })))
    expect(ids()).toEqual(['unrelated', 'root', 'peer'])
  })
  it('includes only exact retired members on an additive checkbox and keeps an invisible parent in the group', async () => {
    vi.mocked(api.sessions.historySources).mockResolvedValue({ sources: [retired, { ...retired, agentSessionId: 'foreign', history: { ...retired.history!, workspacePath: '/foreign' } }], warnings: [] })
    useAppStore.setState({ sessions: [agent('child', 10, 'retired'), { ...agent('exited', 20), processState: 'exited' }] })
    await render()
    expect(ids()).toEqual(['child', 'exited'])
    expect(dom.container.querySelector('[data-agent-group-key]')?.getAttribute('data-agent-group-key')).toBe(key('retired'))
    expect(dom.container.querySelector('[data-agent-depth]')?.getAttribute('data-agent-depth')).toBe('1')
    await act(async () => dom.container.querySelector<HTMLButtonElement>('[data-agent-filter="working"]')!.click())
    await closed()
    expect(ids()).toEqual(['retired'])
    expect(button('Resume Agent retired')).toBeDefined()
    expect(dom.container.querySelector('[data-agent-filter="all"]')?.textContent).toBe('All 2')
  })
  it('resumes the original native identity once, and only reconciles the same operation after an unknown reply', async () => {
    vi.mocked(api.sessions.historySources).mockResolvedValue({ sources: [retired], warnings: [] })
    const native = { source: { nativeHandle: retired.history!.nativeHandle!, workspacePath: workspace.path, revision: 'native-lifetime' }, updatedAt: 100,
      managed: { agentSessionId: 'retired', executorId: 'codex', run: { runId: 'original-retired-run' }, state: 'retired' as const, retiredAt: 100 } }
    vi.spyOn(api.sessions, 'nativeSessions').mockResolvedValue({ hostId: 'local', executorId: 'codex', providerId: 'codex', availability: 'available',
      capabilities: composerSession().capabilities, sessions: [native], issues: [] })
    const reopen = vi.spyOn(api.sessions, 'reopen').mockRejectedValue(new Error('Reply unavailable'))
    const reconcile = vi.spyOn(api.sessions, 'reconcileReopen').mockRejectedValue(new Error('Still unconfirmed'))
    vi.spyOn(api.sessions, 'creation').mockRejectedValue(new Error('Observation unavailable'))
    const launch = vi.spyOn(api.sessions, 'launchAgent'), stop = vi.spyOn(api.sessions, 'stop')
    await render(); await closed()
    await act(async () => button('Resume Agent retired').click())
    expect(reopen).toHaveBeenCalledTimes(1)
    expect(ids()).toContain('retired')
    const operation = reopen.mock.calls[0]![2]
    const resumed = { ...agent('retired', 5), nativeSessionId: 'native-retired' }
    reconcile.mockResolvedValue(resumed)
    await act(async () => button('Resume Agent retired').click())
    expect(reopen).toHaveBeenCalledTimes(1)
    expect(reconcile.mock.calls.at(-1)).toEqual([{ hostId: 'local', agentSessionId: 'retired' }, 100, operation])
    expect(useAppStore.getState().sessions.find(session => session.id === 'retired')).toMatchObject({ nativeSessionId: 'native-retired' })
    expect(launch).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
    expect(useAppStore.getState().agentComposerDrafts.root).toBe('original unsent draft')
  })
  it('retains all members on cycles, absent parents and distinct Hosts without inventing ancestry', () => {
    const sessions = [agent('a', 1, 'b'), agent('b', 2, 'a'), agent('c', 3, 'missing'), { ...agent('other', 4, 'a'), hostId: 'remote', control: { ...composerSession('other').control, hostId: 'remote' } }]
    const groups = workspaceAgentGroups(sessions)
    expect(groups).toHaveLength(4)
    expect(groups.flatMap(group => group.members.map(member => member.depth))).toEqual([0, 0, 0, 0])
  })
  it('permits a new explicit restore after Core confirms not_applied, and a late result preserves later navigation', async () => {
    vi.mocked(api.sessions.historySources).mockResolvedValue({ sources: [retired], warnings: [] })
    const refusal = Object.assign(new Error('Restore not applied'), { controlFailure: { disposition: 'not_applied' } })
    const reopen = vi.spyOn(api.sessions, 'reopen').mockRejectedValueOnce(refusal)
    vi.spyOn(api.sessions, 'creation').mockRejectedValue(new Error('Observation unavailable'))
    const reconcile = vi.spyOn(api.sessions, 'reconcileReopen')
    await render(); await closed()
    await act(async () => button('Resume Agent retired').click())
    const firstOperation = reopen.mock.calls[0]![2]
    let finish!: (value: ReturnType<typeof agent>) => void
    reopen.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await act(async () => button('Resume Agent retired').click())
    expect(reopen).toHaveBeenCalledTimes(2)
    expect(reopen.mock.calls[1]![2]).not.toBe(firstOperation)
    await act(async () => useAppStore.setState({ mainSurface: 'agents' }))
    await act(async () => finish({ ...agent('retired', 5), nativeSessionId: 'native-retired' }))
    expect(reconcile).not.toHaveBeenCalled()
    expect(useAppStore.getState().mainSurface).toBe('agents')
    expect(useAppStore.getState().sessions.some(session => session.id === 'retired')).toBe(true)
  })
  it('keeps a newer order when relationship observation overlaps another edit', async () => {
    let release!: (value: { sources: AgentSessionHistoryDescriptor[]; warnings: [] }) => void
    vi.mocked(api.sessions.historySources).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const pending = useAppStore.getState().setWorkspaceAgentOrder(workspace.id, [key('unrelated'), key('root'), key('retired')])
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const newer = ['root', 'child', 'grandchild', 'unrelated'].map(id => key(id))
    useAppStore.setState({ workspaceAgentOrder: { [workspace.id]: newer } })
    release({ sources: [retired], warnings: [] })
    expect(await pending).toMatchObject({ outcome: 'refused', issues: expect.arrayContaining([expect.objectContaining({ code: 'AGENT_ORDER_CONFLICT' })]) })
    expect(useAppStore.getState().workspaceAgentOrder[workspace.id]).toEqual(newer)
  })
  it('keeps manual sorting and reset usable without waiting for optional history or A2A reads', async () => {
    vi.mocked(api.sessions.historySources).mockImplementation(() => new Promise(() => {}))
    vi.mocked(api.sessions.messageEvents).mockImplementation(() => new Promise(() => {}))
    const result = await useAppStore.getState().setWorkspaceAgentOrder(workspace.id, [key('unrelated'), key('root')])
    expect(result).toMatchObject({ changed: true, storedOrder: ['unrelated', 'root', 'child', 'grandchild'].map(id => ({ hostId: 'local', agentSessionId: id })) })
    expect(api.sessions.historySources).not.toHaveBeenCalled(); expect(api.sessions.messageEvents).not.toHaveBeenCalled()
    expect(await useAppStore.getState().setWorkspaceAgentOrder(workspace.id, [])).toMatchObject({ changed: true, storedOrder: [] })
    expect(api.sessions.historySources).not.toHaveBeenCalled(); expect(api.sessions.messageEvents).not.toHaveBeenCalled()
  }, 1500)
  it('keeps a newer original Core Session visible when the retirement catalogue cannot refresh', async () => {
    let publish: ((value: Parameters<Parameters<typeof api.sessions.onEvent>[0]>[0]) => void)[] = []
    vi.spyOn(api.sessions, 'onEvent').mockImplementation(listener => { publish.push(listener); return () => { publish = publish.filter(value => value !== listener) } })
    vi.mocked(api.sessions.historySources).mockResolvedValueOnce({ sources: [retired], warnings: [] }).mockRejectedValue(new Error('Catalogue unavailable'))
    await render(); expect(ids()).not.toContain('retired')
    const resumed = { ...agent('retired', 5), nativeSessionId: 'native-retired', agentSessionUpdatedAt: 101 }
    await act(async () => {
      useAppStore.setState(state => ({ sessions: [...state.sessions, resumed] }))
      for (const listener of publish) listener({ type: 'core', hostId: 'local', event: { type: 'run-removed', agentSessionId: 'retired', runId: 'old-retired-run' } } as Parameters<typeof listener>[0])
    })
    expect(ids()).toContain('retired')
    expect(button('Resume Agent retired')).toBeUndefined()
    expect(dom.container.textContent).toContain('Catalogue unavailable')
    await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'retired' ? { ...session, runUnobserved: true } : session) })))
    expect(ids()).toContain('retired')
    const { workspaceAgentOrderEntries } = await import('../src/renderer/src/lib/workspace-agent-relations')
    const entries = workspaceAgentOrderEntries(useAppStore.getState(), workspace, [retired])
    expect(entries.find(entry => entry.id === 'retired')).toBe(useAppStore.getState().sessions.find(session => session.id === 'retired'))
    await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'retired' ? { ...session, agentSessionUpdatedAt: 99 } : session) })))
    expect(ids()).not.toContain('retired')
    await closed(); expect(ids()).toContain('retired'); expect(button('Resume Agent retired')).toBeDefined()
  })
  it('lets Refresh recover failed relationship reads while retaining the same live list', async () => {
    vi.mocked(api.sessions.messageEvents).mockRejectedValue(new Error('Relationship source unavailable'))
    await render()
    expect(ids()).toEqual(['root', 'child', 'grandchild', 'unrelated'])
    expect(dom.container.textContent).toContain('Communication proximity is partially observed')
    const before = vi.mocked(api.sessions.messageEvents).mock.calls.length
    vi.mocked(api.sessions.messageEvents).mockImplementation(async subject => page(subject.agentSessionId))
    await act(async () => [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Refresh')!.click())
    expect(api.sessions.messageEvents).toHaveBeenCalledTimes(before + 4)
    expect(dom.container.textContent).not.toContain('Communication proximity is partially observed')
    expect(ids()).toEqual(['root', 'child', 'grandchild', 'unrelated'])
  })
})
