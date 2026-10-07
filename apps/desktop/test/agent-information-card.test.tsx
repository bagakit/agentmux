// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxRpcResult, AgentSessionHistoryPage } from '@agentmux/core'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { composerDOM, composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { WorkspaceAgentRow } from '../src/renderer/src/components/WorkspaceAgentRow'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'
vi.mock('../src/renderer/src/components/AgentAvatar', () => ({ AgentAvatar: () => createElement('span') }))
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/components/RecentFocusTimeline', () => ({ RecentFocusTimeline: () => null }))
vi.mock('../src/renderer/src/lib/use-focus-hierarchy', () => ({ useFocusHierarchy: () => ({ facts: { topics: {}, worktrees: [] }, errors: [] }) }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { WorkspaceAgentsTool } from '../src/renderer/src/components/SurfaceToolDock'

const dom = composerDOM(), workspace = composerConfig.workspaces[0]!, sid = 'information-agent'
const usage = { scope: 'response' as const, inputTokens: 1400, outputTokens: 100, totalTokens: 1500,
  cumulative: { scope: 'native-session' as const, inputTokens: 500000, outputTokens: 40000, totalTokens: 540000 },
  context: { usedTokens: 8000, capacityTokens: 32000 }, observedAt: fixtureEpoch(1) }
const agent = { ...composerSession(sid), label: 'Original task', turnUsage: usage }
const goal: DemandRecord = { id: 'information-goal', title: 'Keep original reading', description: '', status: 'in_progress', priority: 'normal',
  projectId: null, projectName: null, sessionIds: [], source: 'default-topic', createdAt: fixtureEpoch(1), updatedAt: fixtureEpoch(1),
  participations: [{ id: 'original-discussion', operationId: 'original-discussion', hostId: 'local', agentSessionId: sid, kind: 'discussion', entryPoint: 'original-entry', recordedAt: fixtureEpoch(1) }] }
const native = (id: string): AgentSessionHistoryPage => ({ agentSessionId: id, source: { providerId: 'codex', nativeSessionId: 'native-' + id }, nextCursor: 'original-earlier-cursor',
  items: [{ id: 'original-input', kind: 'user-message', startedAt: fixtureEpoch(1), contentParts: [{ kind: 'text', text: '[Message from Agent declared-peer]\\nDeclared text is not authenticated communication.' }] }] })
type Page = AgentMuxRpcResult<'message.dispatch.ls'>
const page = (hostId = 'local', participantSessionId = sid, to = 'original-worker'): Page => ({ hostId, participantSessionId, nextSourceMessageId: 'original-more-cursor', dispatches: [
  { sourceMessageId: 'original-outbound', ownerAgentSessionId: participantSessionId, workerAgentSessionId: to, threadId: 'original-thread', openedAt: fixtureEpoch(1), originAwaits: true, events: [] },
  { sourceMessageId: 'original-inbound', ownerAgentSessionId: 'original-owner', workerAgentSessionId: participantSessionId, threadId: 'original-other-thread', openedAt: fixtureEpoch(1), originAwaits: false, events: [] }
] })
const panel = () => document.querySelector<HTMLElement>('.focus-context-hover')!
const card = (surface: 'focus' | 'workspace') => dom.container.querySelector<HTMLButtonElement>(surface === 'focus' ? '.global-focus-surface .focus-context[data-session-id]' : '.workspace-agents-tool .workspace-agent-row')!
async function open(surface: 'focus' | 'workspace') { await act(async () => card(surface).focus()); await act(async () => vi.waitFor(() => expect(panel()).not.toBeNull())) }
async function disclose(label: string) {
  const details = [...panel().querySelectorAll<HTMLDetailsElement>('details')].find(node => node.querySelector('summary')?.textContent?.startsWith(label))!
  expect(details).toBeDefined()
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
}
async function close() { await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); expect(panel()).toBeNull() }
async function mount() { await dom.render(<><GlobalFocusSurface workspaceOpen={false} /><WorkspaceAgentsTool workspace={workspace} sessions={[agent]} onOpen={() => { throw Error('Reading must not navigate') }} /></>) }
beforeEach(() => {
  useAppStore.setState({ loading: false, config: composerConfig, sessions: [agent], mainSurface: 'agents', agentNames: { [sid]: 'Original task' }, tabs: {}, layouts: {}, scratchTopicSnapshots: {}, demands: { [goal.id]: goal },
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } }, agentComposerDrafts: { [sid]: 'Original draft' },
    timelines: { [sid]: { agentSessionId: sid, revision: 1, items: [{ id: 'original-reply', agentSessionId: sid, kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Reply', content: 'Original **reply** and complete source.', createdAt: fixtureEpoch(1), updatedAt: fixtureEpoch(1) }] } } })
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async control => native(control.agentSessionId))
  vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async control => ({ agentSessionId: control.agentSessionId, source: { providerId: 'codex', nativeSessionId: 'native-' + control.agentSessionId }, dispose() {} }))
  vi.spyOn(api.sessions, 'dispatches').mockResolvedValue(page())
  vi.spyOn(api.ui, 'openObjectLink').mockResolvedValue(undefined)
})

it.each(['focus', 'workspace'] as const)('%s consumes shared usage, exact Goal and original message relationships only on disclosure', async surface => {
  await mount(); expect(api.sessions.historyPage).not.toHaveBeenCalled(); expect(api.sessions.dispatches).not.toHaveBeenCalled()
  expect(card(surface).querySelector('button')).toBeNull()
  await open(surface); expect(panel().textContent).toContain('75% context left'); expect(panel().textContent).toContain('540k Session tokens')
  expect(api.sessions.dispatches).not.toHaveBeenCalled()
  await disclose('Usage'); expect(panel().querySelector('[data-agent-usage-scope="native-session"]')!.textContent).toContain('540k')
  expect(panel().querySelector('[data-agent-usage-scope="response"]')!.textContent).toContain('1.5k')
  expect(panel().textContent).toContain('24k remaining')
  await disclose('Connections'); await act(async () => vi.waitFor(() => expect(panel().textContent).toContain('original-worker')))
  expect(panel().querySelectorAll('[data-goal-id="information-goal"]')).toHaveLength(1); expect(panel().textContent).toContain('Discussion')
  expect(api.sessions.dispatches).toHaveBeenCalledExactlyOnceWith({ hostId: 'local', agentSessionId: sid }, { limit: 10 })
  expect(panel().textContent).toContain('Request to'); expect(panel().textContent).toContain('Request from'); expect(panel().textContent).toContain('Loaded records only')
  expect(panel().textContent).toContain('More records are available')
  expect(panel().querySelector('.agent-information-relations__messages button')).toBeNull()
  expect(panel().textContent).toContain('Peer location is not confirmed')
  expect(api.ui.openObjectLink).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('Original draft'); expect(useAppStore.getState().agentFocus.execution.sessionId).toBeNull()
})
it('retains the original reply DOM and selection while usage updates in the shared detail', async () => {
  await mount(); await open('workspace'); const reply = panel().querySelector('.focus-context-hover__recap p')!, range = document.createRange(); range.selectNodeContents(reply)
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range); const selected = window.getSelection()!.toString()
  const count = vi.mocked(api.sessions.historyPage).mock.calls.length
  await act(async () => useAppStore.setState({ sessions: [{ ...agent, turnUsage: { ...usage, context: { usedTokens: 16000, capacityTokens: 32000 } } }] }))
  expect(panel().textContent).toContain('50% context left'); expect(panel().querySelector('.focus-context-hover__recap p')).toBe(reply)
  expect(window.getSelection()!.toString()).toBe(selected); expect(api.sessions.historyPage).toHaveBeenCalledTimes(count); expect(api.sessions.dispatches).not.toHaveBeenCalled()
})
it('does not infer communication from a native body prefix or claim exhaustive absence', async () => {
  vi.mocked(api.sessions.dispatches).mockResolvedValue({ hostId: 'local', participantSessionId: sid, dispatches: [], nextSourceMessageId: null })
  await mount(); await open('focus'); await disclose('Connections')
  await act(async () => vi.waitFor(() => expect(panel().textContent).toContain('No supervised requests in this reading window.')))
  expect(panel().querySelector('.agent-information-relations__messages')!.textContent).not.toContain('declared-peer')
  expect(panel().querySelector('[data-input-author]')?.getAttribute('data-input-author')).toBe('unknown')
})
it.each(['host', 'participant', 'record'] as const)('keeps a wrong %s query result unknown without changing the Agent or hiding the original reply', async wrong => {
  const result = page(wrong === 'host' ? 'other-host' : 'local', wrong === 'participant' ? 'other-agent' : sid)
  const checked = wrong === 'record' ? { ...result, dispatches: [{ ...result.dispatches[0]!, ownerAgentSessionId: 'other-owner', workerAgentSessionId: 'other-worker' }, ...result.dispatches.slice(1)] } : result
  vi.mocked(api.sessions.dispatches).mockResolvedValue(checked)
  await mount(); const before = useAppStore.getState(); await open('focus'); await disclose('Connections')
  await act(async () => vi.waitFor(() => expect(panel().textContent).toContain('Message relationships unavailable')))
  expect(panel().textContent).toContain('Original reply'); expect(panel().querySelector('.agent-information-relations__messages button')).toBeNull()
  expect(useAppStore.getState().sessions).toBe(before.sessions); expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})
it('does not revive a closed reader or add message demand after the Focus surface is hidden', async () => {
  let resolve!: (result: Page) => void
  vi.mocked(api.sessions.dispatches).mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await mount(); await open('focus'); await disclose('Connections'); await close()
  await act(async () => resolve(page('local', sid, 'late-worker'))); expect(panel()).toBeNull()
  await open('workspace'); expect(panel().textContent).not.toContain('late-worker'); expect(api.sessions.dispatches).toHaveBeenCalledTimes(1)
  await close(); await dom.render(<GlobalFocusSurface visible={false} />); expect(panel()).toBeNull(); expect(api.sessions.dispatches).toHaveBeenCalledTimes(1)
})
it('keeps canonical same-SID usage isolated by exact Host and Run in the reusable workspace row', async () => {
  const remote = { ...agent, hostId: 'remote', control: { ...agent.control, hostId: 'remote', run: { runId: 'remote-run' } }, turnUsage: { ...usage, cumulative: { ...usage.cumulative, totalTokens: 90000 } } }
  useAppStore.setState({ sessions: [agent, remote] })
  const context = agentContextForSession(remote, undefined, 'Remote task', { ...workspace, hostId: 'remote' }, null)
  await dom.render(<WorkspaceAgentRow context={context} percent={null} onOpen={() => { throw Error('Reading must not navigate') }} />)
  await act(async () => dom.container.querySelector<HTMLButtonElement>('.workspace-agent-row')!.focus())
  await act(async () => vi.waitFor(() => expect(panel()).not.toBeNull()))
  expect(panel().textContent).toContain('90k Session tokens'); expect(panel().textContent).not.toContain('540k')
})

it('keeps a recorded peer SID without borrowing another Host display name', async () => {
  const peer = composerSession('recorded-peer'), foreign = { ...peer, hostId: 'foreign-host', label: 'Foreign display name', control: { ...peer.control, hostId: 'foreign-host' } }
  const timeline = useAppStore.getState().timelines[sid]!
  useAppStore.setState({ sessions: [foreign, agent, peer], agentNames: { [sid]: 'Original task', 'recorded-peer': 'Unqualified display name' },
    timelines: { [sid]: { ...timeline, revision: 2, items: [{ ...timeline.items[0]!, id: 'recorded-agent-input', kind: 'user_message', source: 'user', authorAgentSessionId: 'recorded-peer', content: 'Recorded incoming request' }, ...timeline.items] } } })
  await mount(); await open('workspace')
  const row = panel().querySelector('[data-input-author="agent"]')!
  expect(row).not.toBeNull(); expect(row.querySelector('strong')!.textContent).toBe('recorded-peer')
  expect(row.textContent).not.toContain('Foreign display name'); expect(row.textContent).not.toContain('Unqualified display name')
  expect(api.ui.openObjectLink).not.toHaveBeenCalled()
})

it('reads a presentation alias through its original canonical control without opening a neighbor', async () => {
  const alias = { ...agent, id: 'presentation-alias' }
  useAppStore.setState({ sessions: [alias], timelines: {}, agentNames: {} })
  const context = agentContextForSession(alias, undefined, 'Alias task', workspace, null)
  await dom.render(<WorkspaceAgentRow context={context} percent={null} onOpen={() => { throw Error('Reading must not navigate') }} />)
  await act(async () => dom.container.querySelector<HTMLButtonElement>('.workspace-agent-row')!.focus())
  await act(async () => vi.waitFor(() => expect(api.sessions.historyPage).toHaveBeenCalledExactlyOnceWith(alias.control, { limit: 30 })))
  expect(panel().querySelector('[data-hover-input-id]')).not.toBeNull(); expect(api.ui.openObjectLink).not.toHaveBeenCalled()
})
