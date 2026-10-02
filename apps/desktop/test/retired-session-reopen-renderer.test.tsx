import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxAgentSession, AgentSessionHistoryDescriptor, AgentSessionHistoryPage } from '@agentmux/core'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { openAgentHistory } from './helpers/agent-history-menu'
import type { SessionSnapshot } from '../src/shared/contracts'

vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-test="original-terminal">Original terminal</div> }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: () => <textarea aria-label="Original composer" /> }))
vi.mock('../src/renderer/src/components/ActivityView', () => ({ ActivityView: () => <div>Original activity</div> }))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({ SessionResultReview: () => null }))

const initial = useAppStore.getState()
const sid = 'retired-original', native = 'original-native', retiredAt = 42
const source: AgentSessionHistoryDescriptor = { agentSessionId: sid, hostId: 'local', state: 'retired', retiredAt,
  history: { providerId: 'codex', executorId: 'codex', workspacePath: _hygiene_fixturePath("repo"), createdAt: 1,
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: native } } }
const resumed: Extract<SessionSnapshot, { kind: 'agent' }> = { ...composerSession(sid),
  nativeSessionId: native, control: { kind: 'agent', hostId: 'local', agentSessionId: sid, run: { runId: 'new-original-run' } } }
const canonical: AgentMuxAgentSession = { kind: 'agent', agentSessionId: sid, hostId: 'local', providerId: 'codex',
  executorId: 'codex', workspacePath: _hygiene_fixturePath("repo"), run: resumed.control.run, retiredRuns: [{ runId: 'closed-original-run' }],
  createdAt: 1, updatedAt: 2, nativeHandle: source.history!.nativeHandle! }
const history: AgentSessionHistoryPage = { agentSessionId: sid, source: { providerId: 'codex', nativeSessionId: native },
  items: [{ id: 'saved-reply', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Original saved reply' }] }], nextCursor: null }
const tab = createWorkbenchTab('original-tab', { kind: 'agent', regionId: 'original-region', workspaceId: 'workspace', sessionId: sid, phase: 'attached' })
let root: Root, container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  useAppStore.setState(initial, true)
  useAppStore.setState({ config: composerConfig, loading: false, sessions: [], tabs: { [tab.id]: tab },
    layouts: { workspace: createWorkspaceLayout('original-group', [tab.id]) }, activeWorkspaceId: 'workspace',
    viewModes: { [sid]: 'activity' }, agentComposerDrafts: { [sid]: 'Original unsent draft' }, recoveryCandidates: [],
    agentFocus: { execution: { sessionId: sid, history: [] }, pmo: { sessionId: null } } })
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue([source])
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue(history)
  vi.spyOn(api.sessions, 'reopen').mockResolvedValue(resumed)
  vi.spyOn(api.sessions, 'reconcileReopen').mockRejectedValue(new Error('The original operation is still unconfirmed'))
  vi.spyOn(api.sessions, 'creation').mockRejectedValue(new Error('Original identity is still closed'))
  vi.spyOn(api.sessions, 'refresh').mockResolvedValue(resumed)
  vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'launchAgent')
  vi.spyOn(api.sessions, 'submitPrompt')
  vi.spyOn(api.sessions, 'write')
  vi.spyOn(api.sessions, 'recover')
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function mount(readOnly = false, sessionId = sid) {
  await act(async () => root.render(<SessionPane sessionId={sessionId} surfaceKind="agent" interactiveResize={false} visible readOnly={readOnly}
    linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'original-group', tabId: tab.id, regionId: 'original-region' }} />))
}
function button(label: string) {
  const found = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(node => node.textContent?.trim() === label)
  expect(found, `reachable ${label}`).toBeDefined(); return found!
}
async function openHistory() { await act(async () => button('Read conversation history').click()) }
function unchangedWorkface() {
  const state = useAppStore.getState()
  expect(state.tabs).toEqual({ [tab.id]: tab })
  expect(state.agentComposerDrafts[sid]).toBe('Original unsent draft')
  expect(state.recoveryCandidates).toEqual([])
  expect(api.sessions.launchAgent).not.toHaveBeenCalled()
  expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
  expect(api.sessions.write).not.toHaveBeenCalled()
  expect(api.sessions.stop).not.toHaveBeenCalled()
}

it('keeps a closed original conversation readable without automatically starting an Agent', async () => {
  await mount(); expect(container.textContent).toContain('Session closed')
  expect(container.textContent).not.toContain('Codex · Codex')
  expect(button('Continue session').closest('[inert]')).toBeNull()
  await openHistory(); expect(container.textContent).toContain('Original saved reply')
  expect(button('Continue session').closest('[aria-label="Conversation history"]')).not.toBeNull()
  expect(api.sessions.reopen).not.toHaveBeenCalled()
  expect(api.sessions.reconcileReopen).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions).toEqual([]); unchangedWorkface()
})

it.each(['closed', 'history'] as const)('the %s entry consumes the same Core reopen through the real Store and preserves the original Region', async entry => {
  await mount(); if (entry === 'history') await openHistory()
  const originalLayouts = useAppStore.getState().layouts
  await act(async () => button('Continue session').click())
  expect(api.sessions.reopen).toHaveBeenCalledExactlyOnceWith({ hostId: 'local', agentSessionId: sid }, retiredAt, expect.any(String))
  expect(useAppStore.getState().sessions).toEqual([resumed])
  expect(useAppStore.getState().viewModes[sid]).toBe('terminal')
  expect(useAppStore.getState().layouts).toEqual(originalLayouts)
  expect(container.querySelector('[data-test="original-terminal"]')).not.toBeNull()
  expect(container.querySelector('[aria-label="Conversation history"]')).toBeNull()
  unchangedWorkface()
})

it('coalesces pending mouse clicks without a speculative active Session', async () => {
  let finish!: (snapshot: SessionSnapshot) => void
  vi.mocked(api.sessions.reopen).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  await mount(); const action = button('Continue session')
  await act(async () => { action.click(); action.click() })
  expect(api.sessions.reopen).toHaveBeenCalledTimes(1)
  expect(button('Resuming…').disabled).toBe(true)
  expect(useAppStore.getState().sessions).toEqual([]); unchangedWorkface()
  await act(async () => finish(resumed))
  expect(useAppStore.getState().sessions).toEqual([resumed])
})

it('keeps the original readable history and persistent service notice after an unconfirmed action', async () => {
  vi.mocked(api.sessions.reopen).mockRejectedValue(new Error('Native Host connection failed'))
  await mount(); await openHistory()
  await act(async () => button('Continue session').click())
  expect(container.textContent).toContain('Original saved reply')
  expect(container.textContent).toContain('Native Host connection failed')
  expect(container.querySelector('.service-disclosure')).not.toBeNull()
  expect(button('Check again').disabled).toBe(false)
  expect(api.sessions.reopen).toHaveBeenCalledTimes(1)
  expect(api.sessions.creation).toHaveBeenCalledExactlyOnceWith('local', sid)
  expect(api.sessions.reconcileReopen).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions).toEqual([]); unchangedWorkface()
})

it('only reads the original identity on later clicks while the first acknowledgement remains unknown', async () => {
  vi.mocked(api.sessions.reopen).mockRejectedValue(new Error('Native Host connection failed'))
  await mount(); await openHistory()
  await act(async () => button('Continue session').click())
  const originalIntent = vi.mocked(api.sessions.reopen).mock.calls[0]![2]
  expect(originalIntent).toBeTypeOf('string')
  await act(async () => button('Check again').click())
  expect(api.sessions.reopen).toHaveBeenCalledTimes(1)
  expect(api.sessions.reconcileReopen).toHaveBeenCalledExactlyOnceWith({ hostId: 'local', agentSessionId: sid }, retiredAt, originalIntent)
  expect(api.sessions.creation).toHaveBeenCalledTimes(2)
  expect(container.textContent).toContain('Original saved reply')
  vi.mocked(api.sessions.creation).mockResolvedValue(canonical)
  await act(async () => button('Check again').click())
  expect(api.sessions.reopen).toHaveBeenCalledTimes(1)
  expect(api.sessions.reconcileReopen).toHaveBeenCalledTimes(2)
  expect(api.sessions.refresh).toHaveBeenCalledExactlyOnceWith(resumed.control)
  expect(useAppStore.getState().sessions).toEqual([resumed]); unchangedWorkface()
})

it('explicitly reconciles the original unknown intent to its existing canonical Run without another launch', async () => {
  vi.mocked(api.sessions.reopen).mockRejectedValue(new Error('Start acknowledgement unavailable'))
  vi.mocked(api.sessions.reconcileReopen).mockResolvedValue(resumed)
  await mount(); await openHistory()
  await act(async () => button('Continue session').click())
  const originalIntent = vi.mocked(api.sessions.reopen).mock.calls[0]![2]
  expect(api.sessions.reconcileReopen).not.toHaveBeenCalled()
  expect(container.textContent).toContain('Original saved reply')
  await act(async () => button('Check again').click())
  expect(api.sessions.reconcileReopen).toHaveBeenCalledExactlyOnceWith({ hostId: 'local', agentSessionId: sid }, retiredAt, originalIntent)
  expect(api.sessions.reopen).toHaveBeenCalledTimes(1)
  expect(api.sessions.creation).toHaveBeenCalledTimes(1)
  expect(api.sessions.refresh).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions).toEqual([resumed])
  expect(container.querySelector('[data-test="original-terminal"]')).not.toBeNull(); unchangedWorkface()
})

it('permits a new explicit intent after reconciliation authoritatively confirms no native attempt was applied', async () => {
  vi.mocked(api.sessions.reopen).mockRejectedValueOnce(new Error('Start acknowledgement unavailable'))
  vi.mocked(api.sessions.reconcileReopen).mockRejectedValue(Object.assign(new Error('The original operation was not applied'),
    { controlFailure: { disposition: 'not_applied', confirmedInputBytes: null } }))
  await mount(); await act(async () => button('Continue session').click())
  const originalIntent = vi.mocked(api.sessions.reopen).mock.calls[0]![2]
  await act(async () => button('Check again').click())
  expect(api.sessions.reconcileReopen).toHaveBeenCalledExactlyOnceWith({ hostId: 'local', agentSessionId: sid }, retiredAt, originalIntent)
  expect(api.sessions.reopen).toHaveBeenCalledTimes(1)
  expect(button('Continue session').disabled).toBe(false)
  await act(async () => button('Continue session').click())
  const calls = vi.mocked(api.sessions.reopen).mock.calls
  expect(calls).toHaveLength(2)
  expect(calls[0]![2]).not.toBe(calls[1]![2])
  expect(useAppStore.getState().sessions).toEqual([resumed]); unchangedWorkface()
})

it('permits a new explicit intent only after Core confirms the prior action was not applied', async () => {
  vi.mocked(api.sessions.reopen).mockRejectedValueOnce(Object.assign(new Error('Original native locator is unavailable'),
    { controlFailure: { disposition: 'not_applied', confirmedInputBytes: null } }))
  await mount(); await act(async () => button('Continue session').click())
  expect(button('Continue session').disabled).toBe(false)
  expect(useAppStore.getState().sessions).toEqual([])
  await act(async () => button('Continue session').click())
  const calls = vi.mocked(api.sessions.reopen).mock.calls
  expect(calls).toHaveLength(2)
  expect(calls[0]![2]).not.toBe(calls[1]![2])
  expect(useAppStore.getState().sessions).toEqual([resumed]); unchangedWorkface()
})

it('reconciles a lost acknowledgement by reading canonical Core identity and actual Run without another reopen', async () => {
  vi.mocked(api.sessions.reopen).mockRejectedValue(new Error('Reopen acknowledgement unavailable'))
  vi.mocked(api.sessions.creation).mockResolvedValue(canonical)
  await mount(); await openHistory()
  await act(async () => button('Continue session').click())
  expect(api.sessions.reopen).toHaveBeenCalledTimes(1)
  expect(api.sessions.creation).toHaveBeenCalledExactlyOnceWith('local', sid)
  expect(api.sessions.refresh).toHaveBeenCalledExactlyOnceWith(resumed.control)
  expect(useAppStore.getState().sessions).toEqual([resumed]); unchangedWorkface()
})

it.each([
  { label: 'SID', result: { ...resumed, id: 'another-agent' } },
  { label: 'Host', result: { ...resumed, control: { ...resumed.control, hostId: 'another-host' } } },
  { label: 'native conversation', result: { ...resumed, nativeSessionId: 'another-native' } }
])('rejects an unrelated $label without replacing the original history', async ({ result }) => {
  vi.mocked(api.sessions.reopen).mockResolvedValue(result)
  await mount(); await openHistory()
  await act(async () => button('Continue session').click())
  expect(useAppStore.getState().sessions).toEqual([])
  expect(container.textContent).toContain('another conversation identity')
  expect(container.textContent).toContain('Original saved reply'); unchangedWorkface()
})

it('does not accept a different native conversation during lost-ACK reconciliation', async () => {
  vi.mocked(api.sessions.reopen).mockRejectedValue(new Error('Reply unavailable'))
  vi.mocked(api.sessions.creation).mockResolvedValue({ ...canonical, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'different-native' } })
  await mount(); await act(async () => button('Continue session').click())
  expect(api.sessions.refresh).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions).toEqual([]); unchangedWorkface()
})

it('does not turn a noninteractive observation projection into an execution owner', async () => {
  await mount(true); await openHistory()
  expect(container.textContent).toContain('Original saved reply')
  expect(container.textContent).not.toContain('Continue session')
  expect(api.sessions.reopen).not.toHaveBeenCalled()
})

it('lets Core decide native availability when the catalogue observation has no native locator', async () => {
  const { history: _metadata, ...unknownSource } = source
  vi.mocked(api.sessions.historySources).mockResolvedValue([unknownSource])
  vi.mocked(api.sessions.reopen).mockRejectedValue(new Error('Verified native locator is unavailable'))
  await mount(); expect(button('Continue session').disabled).toBe(false)
  await act(async () => button('Continue session').click())
  expect(api.sessions.reopen).toHaveBeenCalledTimes(1)
  expect(container.textContent).toContain('Verified native locator is unavailable')
  expect(button('Read conversation history')).toBeDefined()
})

it('keeps the user’s later focus when the original conversation finishes reopening', async () => {
  let finish!: (snapshot: SessionSnapshot) => void
  vi.mocked(api.sessions.reopen).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  await mount(); await act(async () => button('Continue session').click())
  const laterFocus = { execution: { sessionId: 'healthy-neighbor', history: [{ sessionId: 'healthy-neighbor', focusedAt: 12 }] }, pmo: { sessionId: null } }
  useAppStore.setState({ agentFocus: laterFocus, activeWorkspaceId: 'another-workspace' })
  await act(async () => finish(resumed))
  expect(useAppStore.getState().agentFocus).toEqual(laterFocus)
  expect(useAppStore.getState().activeWorkspaceId).toBe('another-workspace')
  unchangedWorkface()
})

it('keeps an explicitly closed Region closed without inventing a Tab or stopping the canonical Run', async () => {
  let finish!: (snapshot: SessionSnapshot) => void
  vi.mocked(api.sessions.reopen).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  await mount(); await act(async () => button('Continue session').click())
  useAppStore.setState({ tabs: {} })
  await act(async () => finish(resumed))
  expect(useAppStore.getState().tabs).toEqual({})
  expect(api.sessions.stop).not.toHaveBeenCalled()
  expect(api.sessions.launchAgent).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions).toEqual([])
})

it('rejects an absent original Region before sending a lifecycle operation', async () => {
  useAppStore.setState({ tabs: {} })
  await expect(useAppStore.getState().reopenRetiredSession(source)).rejects.toThrow('original conversation Region')
  expect(api.sessions.reopen).not.toHaveBeenCalled()
})

it('keeps the original active dormant Session recovery reachable directly in the History toolbar', async () => {
  const dormant = { ...resumed, processState: 'interrupted' as const, control: { ...resumed.control, run: { runId: 'original-ended-run' } } }
  useAppStore.setState({ sessions: [dormant] })
  vi.mocked(api.sessions.recover).mockResolvedValue({ kind: 'resumed', session: resumed })
  await mount(); await openAgentHistory(container)
  const reader = container.querySelector('[aria-label="Conversation history"]')!
  expect(reader).not.toBeNull()
  expect(button('Resume').closest('.session-history__toolbar')).not.toBeNull()
  expect(button('Resume').closest('[inert]')).toBeNull()
  await act(async () => button('Resume').click())
  expect(api.sessions.recover).toHaveBeenCalledExactlyOnceWith(dormant.control, dormant.workspacePath, undefined)
  expect(api.sessions.reopen).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions).toEqual([resumed]); unchangedWorkface()
})

it('returns from a healthy Session History to its original terminal without starting another Run', async () => {
  useAppStore.setState({ sessions: [resumed], viewModes: { [sid]: 'terminal' } })
  await mount(); await openAgentHistory(container)
  expect(container.textContent).toContain('Original saved reply')
  await act(async () => button('Terminal').click())
  expect(container.querySelector('[data-test="original-terminal"]')).not.toBeNull()
  expect(api.sessions.reopen).not.toHaveBeenCalled()
  expect(api.sessions.recover).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions).toEqual([resumed]); unchangedWorkface()
})

it('after actual Pane remount explicitly checks the original Core correlation without repeating Continue', async () => {
  vi.mocked(api.sessions.reopen).mockRejectedValueOnce(new Error('Start acknowledgement unavailable'))
  await mount(); await openHistory()
  await act(async () => button('Continue session').click())
  const originalIntent = vi.mocked(api.sessions.reopen).mock.calls[0]![2]
  vi.mocked(api.sessions.historySources).mockResolvedValue([{ ...source, pendingReopen: { operationId: originalIntent } }])
  await act(async () => root.render(null))
  await mount(); await openHistory()
  expect(container.textContent).toContain('Original saved reply')
  expect(container.querySelector('.service-disclosure')).not.toBeNull()
  expect(button('Check again').disabled).toBe(false)
  expect(api.sessions.reopen).toHaveBeenCalledTimes(1); expect(api.sessions.reconcileReopen).not.toHaveBeenCalled()
  vi.mocked(api.sessions.reconcileReopen).mockResolvedValueOnce(resumed)
  await act(async () => button('Check again').click())
  expect(api.sessions.reconcileReopen).toHaveBeenCalledExactlyOnceWith({ hostId: 'local', agentSessionId: sid }, retiredAt, originalIntent)
  expect(api.sessions.reopen).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().sessions).toEqual([resumed]); unchangedWorkface()
})

it('keeps a remounted pending operation without its correlation unknown and readable', async () => {
  vi.mocked(api.sessions.historySources).mockResolvedValue([{ ...source, pendingReopen: {} }])
  await mount(); await openHistory()
  expect(container.textContent).toContain('Original saved reply')
  expect(container.textContent).toContain('correlation is unavailable')
  expect(button('Check again').disabled).toBe(false)
  await act(async () => button('Check again').click())
  expect(api.sessions.historySources).toHaveBeenCalledTimes(2)
  expect(api.sessions.reopen).not.toHaveBeenCalled(); expect(api.sessions.reconcileReopen).not.toHaveBeenCalled()
  expect(container.textContent).toContain('Original saved reply'); unchangedWorkface()
})

it('clears a remounted correlation only after Core authoritatively confirms not applied', async () => {
  vi.mocked(api.sessions.historySources).mockResolvedValue([{ ...source, pendingReopen: { operationId: 'original-durable-intent' } }])
  vi.mocked(api.sessions.reconcileReopen).mockRejectedValueOnce(Object.assign(new Error('Original operation was not applied'),
    { controlFailure: { disposition: 'not_applied', confirmedInputBytes: null } }))
  await mount(); await act(async () => button('Check again').click())
  expect(api.sessions.reconcileReopen).toHaveBeenCalledExactlyOnceWith({ hostId: 'local', agentSessionId: sid }, retiredAt, 'original-durable-intent')
  expect(api.sessions.reopen).not.toHaveBeenCalled()
  await act(async () => button('Continue session').click())
  expect(api.sessions.reopen).toHaveBeenCalledExactlyOnceWith({ hostId: 'local', agentSessionId: sid }, retiredAt, expect.any(String))
  expect(vi.mocked(api.sessions.reopen).mock.calls[0]![2]).not.toBe('original-durable-intent')
  expect(useAppStore.getState().sessions).toEqual([resumed]); unchangedWorkface()
})
