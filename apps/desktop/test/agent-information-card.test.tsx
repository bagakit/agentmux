// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { GRAPHITE_THEME, mountThemeRuntime, previewTheme } from '@agentmux/client-ui/theme'
import { semanticIconHref } from '@agentmux/client-ui/icons'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxRpcResult, AgentSessionHistoryPage } from '@agentmux/core'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { composerDOM, composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { agentCardConversationFixture, waitForAgentCardReading } from './helpers/agent-card-conversation-fixture'
import { WorkspaceAgentRow } from '../src/renderer/src/components/WorkspaceAgentRow'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'
vi.mock('../src/renderer/src/components/AgentAvatar', async importOriginal => ({ ...await importOriginal<typeof import('../src/renderer/src/components/AgentAvatar')>(), AgentAvatar: () => createElement('span') }))
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/components/RecentFocusTimeline', () => ({ RecentFocusTimeline: () => null }))
vi.mock('../src/renderer/src/lib/use-focus-hierarchy', () => ({ useFocusHierarchy: () => ({ facts: { topics: {}, worktrees: [] }, errors: [] }) }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { WorkspaceAgentsTool } from '../src/renderer/src/components/SurfaceToolDock'

const dom = composerDOM({ agentInformation: true }), workspace = composerConfig.workspaces[0]!, sid = 'information-agent'
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
const card = (surface: 'focus' | 'workspace') => dom.container.querySelector<HTMLButtonElement>(surface === 'focus' ? '.global-focus-surface .focus-context[data-session-id]' : '.workspace-agents-tool .focus-context')!
async function open(surface: 'focus' | 'workspace') { await act(async () => card(surface).focus()); await waitForAgentCardReading(() => { expect(panel()).not.toBeNull(); expect(panel().querySelector('[data-hover-input-id]')).not.toBeNull() }) }
async function disclose(label: string) {
  if (!panel().querySelector('.agent-information-reader__metadata')) await act(async () => panel().querySelector<HTMLButtonElement>('.agent-information-reader__facts')!.click())
  const button = [...panel().querySelectorAll<HTMLButtonElement>('.agent-information-details__tabs button')].find(node => node.textContent === label)!
  expect(button).toBeDefined(); await act(async () => button.click())
}
async function close() {
  if (panel()?.querySelector('.agent-information-reader__metadata')) await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(panel()).toBeNull()
}
async function mount() { await dom.render(<><GlobalFocusSurface workspaceOpen={false} /><WorkspaceAgentsTool workspace={workspace} sessions={[agent]} onOpen={() => { throw Error('Reading must not navigate') }} /></>) }
beforeEach(async () => {
  useAppStore.setState({ loading: false, config: composerConfig, sessions: [agent], mainSurface: 'agents', agentNames: { [sid]: 'Original task' }, tabs: {}, layouts: {}, scratchTopicSnapshots: {}, demands: { [goal.id]: goal },
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } }, agentComposerDrafts: { [sid]: 'Original draft' },
    timelines: { [sid]: { agentSessionId: sid, revision: 1, items: [{ id: 'original-reply', agentSessionId: sid, kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Reply', content: 'Original **reply** and complete source.', createdAt: fixtureEpoch(1), updatedAt: fixtureEpoch(1) }] } } })
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async control => native(control.agentSessionId))
  vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async control => ({ agentSessionId: control.agentSessionId, source: { providerId: 'codex', nativeSessionId: 'native-' + control.agentSessionId }, dispose() {} }))
  vi.spyOn(api.sessions, 'dispatches').mockResolvedValue(page())
  vi.spyOn(api.ui, 'openObjectLink').mockResolvedValue(undefined)
  await agentCardConversationFixture(control => native(control.agentSessionId).source)
})

it.each(['focus', 'workspace'] as const)('%s consumes shared usage, exact Goal and original message relationships only on disclosure', async surface => {
  await mount(); expect(api.sessions.historyPage).not.toHaveBeenCalled(); expect(api.sessions.dispatches).not.toHaveBeenCalled()
  expect(card(surface).querySelector('button')).toBeNull()
  await open(surface); expect(panel().querySelector('[title="75% context remaining"]')).not.toBeNull(); expect(panel().textContent).toContain('540k native Session tokens')
  expect(api.sessions.dispatches).not.toHaveBeenCalled()
  await disclose('Usage'); expect(panel().querySelector('[data-agent-usage-scope="native-session"]')!.textContent).toContain('540k')
  expect(panel().querySelector('[data-agent-usage-scope="response"]')!.textContent).toContain('1.5k')
  expect(panel().textContent).toContain('24k remaining')
  await disclose('Goals')
  expect(panel().querySelectorAll('[data-goal-id="information-goal"]')).toHaveLength(1); expect(panel().textContent).toContain('Discussion')
  await disclose('Messages'); await act(async () => vi.waitFor(() => expect(panel().textContent).toContain('original-worker')))
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
  expect(panel().querySelector('[title="50% context remaining"]')).not.toBeNull(); expect(panel().querySelector('.focus-context-hover__recap p')).toBe(reply)
  expect(window.getSelection()!.toString()).toBe(selected); expect(api.sessions.historyPage).toHaveBeenCalledTimes(count); expect(api.sessions.dispatches).not.toHaveBeenCalled()
})
it('does not infer communication from a native body prefix or claim exhaustive absence', async () => {
  vi.mocked(api.sessions.dispatches).mockResolvedValue({ hostId: 'local', participantSessionId: sid, dispatches: [], nextSourceMessageId: null })
  await mount(); await open('focus'); await disclose('Messages')
  await act(async () => vi.waitFor(() => expect(panel().textContent).toContain('No supervised requests in this reading window.')))
  expect(panel().querySelector('.agent-information-relations__messages')!.textContent).not.toContain('declared-peer')
  expect(panel().querySelector('[data-input-author]')?.getAttribute('data-input-author')).toBe('unknown')
})
it.each(['host', 'participant', 'record'] as const)('keeps a wrong %s query result unknown without changing the Agent or hiding the original reply', async wrong => {
  const result = page(wrong === 'host' ? 'other-host' : 'local', wrong === 'participant' ? 'other-agent' : sid)
  const checked = wrong === 'record' ? { ...result, dispatches: [{ ...result.dispatches[0]!, ownerAgentSessionId: 'other-owner', workerAgentSessionId: 'other-worker' }, ...result.dispatches.slice(1)] } : result
  vi.mocked(api.sessions.dispatches).mockResolvedValue(checked)
  await mount(); const before = useAppStore.getState(); await open('focus'); await disclose('Messages')
  await act(async () => vi.waitFor(() => expect(panel().textContent).toContain('Message relationships unavailable')))
  expect(panel().textContent).toContain('Original reply'); expect(panel().querySelector('.agent-information-relations__messages button')).toBeNull()
  expect(useAppStore.getState().sessions).toBe(before.sessions); expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})
it('does not revive a closed reader or add message demand after the Focus surface is hidden', async () => {
  let resolve!: (result: Page) => void
  vi.mocked(api.sessions.dispatches).mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await mount(); await open('focus'); await disclose('Messages'); await close()
  await act(async () => resolve(page('local', sid, 'late-worker'))); expect(panel()).toBeNull()
  await open('workspace'); expect(panel().textContent).not.toContain('late-worker'); expect(api.sessions.dispatches).toHaveBeenCalledTimes(1)
  await close(); await dom.render(<GlobalFocusSurface visible={false} />); expect(panel()).toBeNull(); expect(api.sessions.dispatches).toHaveBeenCalledTimes(1)
})
it('keeps canonical same-SID usage isolated by exact Host and Run in the reusable workspace row', async () => {
  const remote = { ...agent, hostId: 'remote', control: { ...agent.control, hostId: 'remote', run: { runId: 'remote-run' } }, turnUsage: { ...usage, cumulative: { ...usage.cumulative, totalTokens: 90000 } } }
  useAppStore.setState({ sessions: [agent, remote] })
  const context = agentContextForSession(remote, undefined, 'Remote task', { ...workspace, hostId: 'remote' }, null)
  await dom.render(<WorkspaceAgentRow context={context} selected={false} selecting={false} disabled={false} onToggle={() => {}} onOpen={() => { throw Error('Reading must not navigate') }} />)
  await act(async () => dom.container.querySelector<HTMLButtonElement>('.focus-context')!.focus())
  await waitForAgentCardReading(() => { expect(panel()).not.toBeNull(); expect(panel().querySelector('[data-hover-input-id]')).not.toBeNull() })
  expect(panel().textContent).toContain('90k native Session tokens'); expect(panel().textContent).not.toContain('540k')
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
  await dom.render(<WorkspaceAgentRow context={context} selected={false} selecting={false} disabled={false} onToggle={() => {}} onOpen={() => { throw Error('Reading must not navigate') }} />)
  await act(async () => dom.container.querySelector<HTMLButtonElement>('.focus-context')!.focus())
  await waitForAgentCardReading(() => expect(api.sessions.historyPage).toHaveBeenCalledExactlyOnceWith(alias.control, expect.objectContaining({ limit: 100 })))
  expect(panel().querySelector('[data-hover-input-id]')).not.toBeNull(); expect(api.ui.openObjectLink).not.toHaveBeenCalled()
})


it('themes the original reader return control independently while preserving its reading tree, selection and focus', async () => {
  const release = mountThemeRuntime(window, { themeId: 'graphite', appAppearance: 'light' })
  try {
    await mount(); await open('workspace')
    const reader = panel().querySelector<HTMLElement>('.agent-information-reader__reading')!, surface = reader.querySelector<HTMLElement>('[data-agent-input-reading]') ?? reader
    const original = panel().querySelector<HTMLElement>('[data-hover-input-id]')!
    expect(original).not.toBeNull(); expect(original.textContent).toContain('Declared text is not authenticated communication.')
    const range = document.createRange(); range.selectNodeContents(original)
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
    const selection = window.getSelection()!.toString(), historyReads = vi.mocked(api.sessions.historyPage).mock.calls.length
    reader.scrollTop = 23
    await disclose('Usage')
    const back = panel().querySelector<HTMLButtonElement>('[aria-label="Back to original content"]')!, svg = back.querySelector<SVGSVGElement>('svg[data-semantic-icon="navigation.back"]')!
    expect(svg, 'the actual metadata return control uses the Back role').not.toBeNull()
    expect(svg.querySelector('use')!.getAttribute('href')).toBe(semanticIconHref('navigation.back'))
    expect(svg.getAttribute('width')).toBe('13'); expect(document.activeElement).toBe(back)
    const theme = { ...structuredClone(GRAPHITE_THEME), id: 'custom.reader-return', name: 'Independent reader return', icons: {
      'navigation.back': { kind: 'paths' as const, paths: [{ d: 'M4 4H20V20H4Z' }] },
      'status.selected': { kind: 'paths' as const, paths: [{ d: 'M3 12L12 3L21 12L12 21Z' }] }
    } }
    await act(async () => { expect(previewTheme(theme).applied).toBe(true) })
    expect(panel().querySelector('[aria-label="Back to original content"]')).toBe(back); expect(back.querySelector('svg')).toBe(svg)
    expect(document.getElementById(semanticIconHref('navigation.back').slice(1))!.querySelector('path')!.getAttribute('d')).toBe(theme.icons['navigation.back'].paths[0]!.d)
    expect(document.getElementById(semanticIconHref('status.selected').slice(1))!.querySelector('path')!.getAttribute('d')).toBe(theme.icons['status.selected'].paths[0]!.d)
    expect(svg.closest('[data-icon-animation]')).toBeNull(); expect(document.activeElement).toBe(back)
    expect(panel().querySelector('[data-hover-input-id]')).toBe(original)
    await act(async () => back.click())
    expect(panel().querySelector('.agent-information-reader__metadata')).toBeNull()
    expect(panel().querySelector('.agent-information-reader__reading')).toBe(reader); expect(panel().querySelector('[data-hover-input-id]')).toBe(original)
    expect(reader.scrollTop).toBe(23); expect(window.getSelection()!.toString()).toBe(selection); expect(document.activeElement).toBe(surface)
    expect(api.sessions.historyPage).toHaveBeenCalledTimes(historyReads); expect(api.ui.openObjectLink).not.toHaveBeenCalled()
    expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('Original draft'); expect(useAppStore.getState().agentFocus.execution.sessionId).toBeNull()
  } finally { release() }
})
