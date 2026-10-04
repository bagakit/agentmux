import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionRecoveryCandidate, RuntimeEvent, SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { createFocusProjectionSelector, focusColumnFor } from '../src/renderer/src/lib/focus-context'
import { reduceAgentMembershipSnapshot } from '../src/renderer/src/lib/session-state'
import { recoveryCandidateSession, useAppStore } from '../src/renderer/src/store'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { createClientUiRoot } from './helpers/client-ui-render'

// Keep the real Store projection/event owner, Focus selector, hierarchy and cards.
// Native PTY paint and the independent history reader are outside classification.
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/components/RecentFocusTimeline', () => ({ RecentFocusTimeline: () => null }))
const initial = useAppStore.getState()
let root: Root, container: HTMLDivElement, input: HTMLInputElement
function candidate(id = 'missing'): AgentSessionRecoveryCandidate {
  const session = composerSession(id)
  return { ...session, agentSessionId: id, run: session.control.run }
}
const pending = () => recoveryCandidateSession(candidate(), { kind: 'pending', detail: 'Original Run has not been observed. Read or restore the original Session.' })
const row = (id = 'missing') => container.querySelector<HTMLButtonElement>(`.focus-context[data-session-id="${id}"]`)
const columns = () => Object.fromEntries(createFocusProjectionSelector()(useAppStore.getState()).contexts.map(context => [context.id, focusColumnFor(context)]))
const render = () => act(async () => root.render(<GlobalFocusSurface workspaceOpen={false} />))
function processEvent(overrides: Partial<Extract<RuntimeEvent['event'], { type: 'process-state' }>> = {}, hostId = 'local'): RuntimeEvent {
  const run = candidate().run
  return { type: 'core', hostId, event: { type: 'process-state', agentSessionId: 'missing', run, state: 'interrupted', pid: null,
    evidence: { source: 'run-process', observedAt: Date.now() + 1000, run }, ...overrides } }
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useAppStore.setState(initial, true)
  useAppStore.setState({ loading: false, config: composerConfig, mainSurface: 'agents', sessions: [pending()], recoveryCandidates: [candidate()],
    tabs: {}, layouts: {}, timelines: {}, agentNames: { missing: 'Original retained work' }, scratchTopicSnapshots: {}, runtimeEndpointWarnings: [],
    agentComposerDrafts: { missing: 'Keep my original unsent draft' }, agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: _hygiene_fixturePath("repo") })
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'repository', icon: null })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
  container = document.createElement('div'); input = document.createElement('input'); input.value = 'Original text and selection'
  document.body.append(container, input); input.focus(); input.setSelectionRange(2, 8); root = createClientUiRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); input.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
it('keeps the original Store recovery projection visible in Recovery instead of confirming disconnection', async () => {
  const before = useAppStore.getState(), recover = vi.spyOn(api.sessions, 'recover'), snapshot = vi.spyOn(api.sessions, 'snapshot')
  await render()
  expect(row()).not.toBeNull()
  expect(row()!.closest('[data-bucket="idle"]')).not.toBeNull()
  expect(row()!.getAttribute('aria-label')).toContain('Run not observed')
  expect(container.querySelector('[aria-label="Disconnected projects"]')).toBeNull()
  expect(row()!.disabled).toBe(false)
  expect(recover).not.toHaveBeenCalled(); expect(snapshot).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(document.activeElement).toBe(input); expect([input.selectionStart, input.selectionEnd]).toEqual([2, 8])
})
it('lets a same-Run authoritative interruption replace pending provenance despite the retained candidate and absent reason', async () => {
  await render(); const select = createFocusProjectionSelector(), before = select(useAppStore.getState()), candidates = useAppStore.getState().recoveryCandidates
  expect(before.contexts[0]!.stateLabel).toBe('Run not observed')
  await act(async () => useAppStore.getState().applyEvent(processEvent()))
  expect(useAppStore.getState().recoveryCandidates).toBe(candidates)
  expect(useAppStore.getState().sessions[0]!.interruptionReason).toBeUndefined()
  expect(columns()).toEqual({ missing: 'disconnected' })
  expect(select(useAppStore.getState()).contexts[0]!.stateLabel).toBe('Disconnected')
  expect(container.querySelector('[aria-label="Disconnected projects"]')).not.toBeNull()
  expect(row()).toBeNull()
})
it('does not let a wrong Host, old Run or older process observation clear the retained projection', async () => {
  await render(); const original = useAppStore.getState().sessions[0]
  const events = [processEvent({}, 'other-host'), processEvent({ run: { runId: 'older-run' } }),
    processEvent({ evidence: { source: 'run-process', observedAt: 1, run: candidate().run } })]
  for (const event of events) {
    await act(async () => useAppStore.getState().applyEvent(event))
    expect(useAppStore.getState().sessions[0]).toBe(original)
    expect(row()!.getAttribute('aria-label')).toContain('Run not observed')
  }
})
it('uses a canonical snapshot to replace the placeholder and invalidates the original cached label', async () => {
  await render(); const select = createFocusProjectionSelector(); select(useAppStore.getState())
  const confirmed: SessionSnapshot = { ...composerSession('missing'), processState: 'interrupted',
    status: { state: 'disconnected', source: 'run-process', observedAt: Date.now() + 1000 } }
  await act(async () => useAppStore.setState(state => reduceAgentMembershipSnapshot(state, {
    sessions: [confirmed], timelines: { missing: { agentSessionId: 'missing', revision: 1, items: [] } }, recoveryCandidates: []
  }, new Set())))
  expect(select(useAppStore.getState()).contexts[0]!.stateLabel).toBe('Disconnected')
  expect(columns()).toEqual({ missing: 'disconnected' })
})
it('keeps real running connection loss visible, confirmed interrupted Runs compact and recovery errors in Attention', async () => {
  const live: SessionSnapshot = { ...composerSession('healthy'), status: { state: 'disconnected', source: 'run-process', observedAt: 1 } }
  const lost: SessionSnapshot = { ...composerSession('known-lost'), processState: 'interrupted', interruptionReason: 'daemon_restart',
    status: { state: 'disconnected', source: 'run-process', observedAt: 1 } }
  const refusedCandidate = candidate('refused')
  const refused = recoveryCandidateSession(refusedCandidate, { kind: 'unavailable', reason: 'native-handle-unavailable',
    agentSessionId: 'refused', previousRun: refusedCandidate.run, evidence: { kind: 'run-missing', observedAt: 1 } })
  await act(async () => useAppStore.setState({ sessions: [pending(), live, lost, refused] })); await render()
  expect(columns()).toEqual({ missing: 'idle', healthy: 'idle', 'known-lost': 'disconnected', refused: 'attention' })
  expect(row('healthy')).not.toBeNull(); expect(row('refused')).not.toBeNull()
  expect(row('refused')!.getAttribute('aria-label')).toContain('Failed')
})
it('reopening Focus and unrelated output retain the original input, draft and classification without starting or reading Runs', async () => {
  const snapshot = vi.spyOn(api.sessions, 'snapshot'), recover = vi.spyOn(api.sessions, 'recover')
  await render(); const original = useAppStore.getState(), select = createFocusProjectionSelector(), projected = select(original), card = row()
  const branchReads = vi.mocked(api.workspaces.listBranches).mock.calls.length
  await act(async () => useAppStore.setState({ sessions: original.sessions.map(session => ({ ...session, latestOutputBytes: 2048 })) }))
  expect(select(useAppStore.getState()).contexts).toBe(projected.contexts); expect(row()).toBe(card)
  expect(vi.mocked(api.workspaces.listBranches).mock.calls.length).toBe(branchReads)
  await act(async () => root.render(null)); await render()
  expect(columns()).toEqual({ missing: 'idle' }); expect(row()).not.toBeNull()
  expect(useAppStore.getState().tabs).toBe(original.tabs); expect(useAppStore.getState().layouts).toBe(original.layouts)
  expect(useAppStore.getState().agentComposerDrafts).toBe(original.agentComposerDrafts)
  expect(document.activeElement).toBe(input); expect([input.selectionStart, input.selectionEnd]).toEqual([2, 8])
  expect(snapshot).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled()
})
