const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import type { AgentMuxInteractionRequest } from '@agentmux/core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { RuntimeEvent, SessionSnapshot } from '../src/shared/contracts'
vi.hoisted(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
// The original Focus, Attention, Store and lifecycle reducer are loaded. PTY/editor paint is outside this test.
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: ({ sessionId }: { sessionId: string }) => createElement('output', { 'data-visible-session': sessionId }, sessionId) }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
vi.mock('../src/renderer/src/components/EditorPane', () => ({ EditorPane: () => null }))
vi.mock('../src/renderer/src/features/git/diff/GitBranchDiffPane', () => ({ GitBranchDiffPane: () => null }))
vi.mock('../src/renderer/src/components/NewTabSurface', () => ({ NewTabSurface: () => null }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { TransientErrorNotice } from '../src/renderer/src/components/TransientErrorNotice'
import { AttentionRequestPanel } from '../src/renderer/src/components/AttentionRequestPanel'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'

const initial = useAppStore.getState()
type Agent = Extract<SessionSnapshot, { kind: 'agent' }>
let root: Root, container: HTMLDivElement, failed: Agent, healthy: Agent
let listeners: Set<(event: RuntimeEvent) => void>
let sharedTab: ReturnType<typeof createWorkbenchTab>
const drafts = { 'failed-close-a': 'Original failed Session draft', 'failed-close-b': 'Healthy same-name draft' }
const dirty = { 'unrelated-file': true }

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const config = await api.config.get(), snapshot = await api.sessions.snapshot()
  const { pendingInteraction: _pending, ...base } = snapshot.sessions.find((session): session is Agent => session.kind === 'agent')!
  const workspace = { ...config.workspaces[0]!, id: 'failed-workspace', hostId: 'local', path: _hygiene_fixturePath("private/focus-failed"), name: 'Release workspace' }
  failed = { ...base, id: 'failed-close-a', hostId: 'local', workspacePath: workspace.path, label: 'Same Agent', processState: 'exited',
    status: { state: 'error', source: 'run-process', observedAt: 2, detail: 'Executor exited before completing the release', exitCode: 7, exitReason: 'crashed' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: 'failed-close-a', run: { runId: 'failed-run-a' } } }
  healthy = { ...base, id: 'failed-close-b', hostId: 'local', workspacePath: workspace.path, label: failed.label, processState: 'running',
    status: { state: 'working', source: 'native-hook', observedAt: 2 }, control: { kind: 'agent', hostId: 'local', agentSessionId: 'failed-close-b', run: { runId: 'healthy-run-b' } } }
  sharedTab = addWorkbenchRegion(createWorkbenchTab('shared-failure-tab', { kind: 'agent', regionId: 'failed-region', phase: 'attached', workspaceId: workspace.id, sessionId: failed.id }), 'failed-region', 'right',
    { kind: 'agent', regionId: 'healthy-region', phase: 'attached', workspaceId: workspace.id, sessionId: healthy.id })
  useAppStore.setState({ ...initial, config: { ...config, workspaces: [workspace] }, sessions: [failed, healthy], tabs: { [sharedTab.id]: sharedTab },
    layouts: { [workspace.id]: createWorkspaceLayout('failed-group', [sharedTab.id]) }, activeWorkspaceId: workspace.id, mainSurface: 'agents', loading: false,
    agentNames: { [failed.id]: failed.label, [healthy.id]: failed.label }, timelines: {}, scratchTopicSnapshots: {}, agentComposerDrafts: drafts, dirtyDocuments: dirty,
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } }, closingWorkbenchViews: {}, error: null }, true)
  listeners = new Set()
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(listener => { listeners.add(listener); return () => { listeners.delete(listener) } })
  vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); document.getElementById('agentmux-window-overlay-host')?.remove()
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useAppStore.setState(initial, true)
})
const panel = () => container.querySelector<HTMLElement>('.attention-request-panel')
const closeButton = () => [...container.querySelectorAll<HTMLButtonElement>('.attention-request-panel button')].find(button => /^(Close failed Session|Retry closing failed Session|Closing…)$/.test(button.textContent ?? ''))
function ExistingErrorSurface() {
  const error = useAppStore(state => state.error)
  return createElement(TransientErrorNotice, { error, dismissed: false, lastError: null, onDismiss: () => {}, onReopen: () => {} })
}
async function mountReview() {
  await act(async () => root.render(createElement('div', {}, createElement(GlobalFocusSurface), createElement(GlobalSystemNotices), createElement(ExistingErrorSurface))))
  const card = container.querySelector<HTMLButtonElement>(`.global-focus-main [data-session-id="${failed.id}"]`)!
  expect(card, 'Actual failed Focus card').not.toBeNull(); await act(async () => card.click())
  const review = container.querySelector<HTMLButtonElement>('.focus-toolbar__review')!
  expect(review, 'Original Review entry is discoverable for error').not.toBeNull(); expect(review.disabled).toBe(false)
  await act(async () => review.click()); expect(panel()).not.toBeNull()
}
async function clickClose() { expect(closeButton()).toBeDefined(); expect(closeButton()!.disabled).toBe(false); await act(async () => closeButton()!.click()) }
function removal(agent: Agent = failed, runId = agent.control.run.runId): RuntimeEvent {
  return { type: 'core', hostId: agent.hostId, event: { type: 'run-removed', agentSessionId: agent.id, run: { runId }, evidence: { source: 'run-process', observedAt: 3 } } }
}
async function publish(event: RuntimeEvent) {
  await act(async () => { const originalConsumers = [...listeners]; useAppStore.getState().applyEvent(event); originalConsumers.forEach(listener => listener(event)) })
}
function retained() {
  const state = useAppStore.getState()
  expect(state.sessions.find(item => item.id === healthy.id)).toEqual(healthy)
  expect(state.tabs[sharedTab.id]?.regions['healthy-region']).toEqual(sharedTab.regions['healthy-region'])
  expect(state.layouts['failed-workspace']?.groups[0]?.tabOrder).toContain(sharedTab.id)
  expect(state.agentComposerDrafts).toEqual(drafts); expect(state.dirtyDocuments).toEqual(dirty)
}

it('discovers error Review from the actual Focus projection and shows failure facts without fabricating an authorization request', async () => {
  const context = createFocusProjectionSelector()(useAppStore.getState()).contexts.find(item => item.id === failed.id)!
  expect(context).toMatchObject({ bucket: 'attention', actionable: true, liveAgent: false })
  await mountReview(); expect(panel()?.textContent).toContain('Failed Session'); expect(panel()?.textContent).toContain(failed.status.detail)
  expect(panel()?.textContent).toContain('Exit code 7'); expect(panel()?.textContent).toContain('Process crashed')
  expect(panel()?.textContent).not.toContain('No current request'); expect(panel()?.textContent).not.toContain('needs attention, but Core has not exposed')
  expect(closeButton()?.textContent).toBe('Close failed Session'); expect(api.sessions.stop).not.toHaveBeenCalled(); retained()
})
it('uses the exact Session control, retains its surface after API acceptance, and only confirms a matching Core retirement', async () => {
  await mountReview(); await clickClose()
  expect(api.sessions.stop).toHaveBeenCalledExactlyOnceWith(failed.control)
  expect(panel()?.textContent).toContain('Close is not confirmed'); expect(useAppStore.getState().sessions).toEqual([failed, healthy]); expect(useAppStore.getState().tabs[sharedTab.id]).toBe(sharedTab)
  await publish(removal(failed, 'old-run')); expect(panel()?.textContent).not.toContain('Session closed'); expect(useAppStore.getState().sessions).toEqual([failed, healthy])
  await act(async () => useAppStore.setState({ sessions: [healthy] }))
  expect(panel()?.textContent).toContain('close has not been confirmed')
  await act(async () => useAppStore.setState({ sessions: [failed, healthy] }))
  await publish(removal()); expect(panel()?.textContent).toContain('Core confirmed'); expect(useAppStore.getState().sessions).toEqual([healthy]); retained()
})
it('preserves the original failure and the service reason when the Core stop rejects, with a reachable retry', async () => {
  vi.mocked(api.sessions.stop).mockRejectedValueOnce(new Error('Registry is unavailable; close outcome unknown'))
  await mountReview(); await clickClose()
  expect(useAppStore.getState().error).toContain('Registry is unavailable'); expect(container.textContent).toContain('Registry is unavailable')
  expect(panel()?.textContent).toContain(failed.status.detail); expect(closeButton()?.textContent).toBe('Retry closing failed Session')
  expect(useAppStore.getState().sessions).toEqual([failed, healthy]); retained(); await clickClose(); expect(api.sessions.stop).toHaveBeenCalledTimes(2)
})
it('a pending stop has a bounded waiting period and late completion cannot confirm the later retry', async () => {
  vi.useFakeTimers(); let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  vi.mocked(api.sessions.stop).mockReturnValueOnce(pending)
  await mountReview(); await clickClose(); expect(closeButton()?.disabled).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(4_999) }); expect(closeButton()?.disabled).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(1) }); expect(closeButton()?.textContent).toBe('Retry closing failed Session')
  await clickClose(); await act(async () => { release(); await pending })
  expect(api.sessions.stop).toHaveBeenCalledTimes(2); expect(panel()?.textContent).toContain('Close is not confirmed'); expect(useAppStore.getState().sessions).toEqual([failed, healthy]); retained()
})
it.each(['running', 'interrupted', 'unknown'] as const)('error with %s process facts preserves inspect/input capability without granting ended closure', async processState => {
  useAppStore.setState({ sessions: [{ ...failed, processState } as unknown as Agent, healthy] })
  await mountReview(); expect(closeButton()).toBeUndefined()
  expect(panel()?.querySelector('.attention-request-panel__header span')?.textContent).toBe('Session attention')
  expect(panel()?.textContent).not.toContain('Failed Session')
  const open = [...panel()!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Open Session'))!
  expect(open.disabled).toBe(false); expect(api.sessions.stop).not.toHaveBeenCalled(); retained()
  expect(panel()?.textContent).toContain(processState === 'running' ? 'Run is still alive' : 'not confirmed as exited')
})
it.each(['question', 'permission'] as const)('keeps a real %s answer on an errored but running Agent and routes it through its original control', async kind => {
  const evidence = { source: 'native-hook' as const, observedAt: 3, run: failed.control.run }
  const request: AgentMuxInteractionRequest = kind === 'question'
    ? { kind, id: 'retained-question', agentSessionId: failed.id, evidence, questions: [{ id: 'channel', title: 'Choose a release channel', prompt: 'Where should this go?', options: [{ id: 'stable', label: 'Stable' }] }] }
    : { kind, id: 'retained-permission', agentSessionId: failed.id, evidence, title: 'Write the release note?', options: [{ id: 'once', label: 'Allow once', kind: 'allow-once' }] }
  const running = { ...failed, processState: 'running' as const, pendingInteraction: request }
  useAppStore.setState({ sessions: [running, healthy] })
  const response = vi.spyOn(api.sessions, 'respondInteraction').mockResolvedValue(undefined)
  await mountReview()
  expect(panel()?.querySelector('.attention-request-panel__header span')?.textContent).toBe('Session attention')
  expect(closeButton()).toBeUndefined()
  const requestCard = panel()?.querySelector(`[aria-label="${kind === 'question' ? 'Agent question' : 'Agent permission request'}"]`)
  expect(requestCard, 'The original typed card remains usable beside the current error facts').not.toBeNull()
  const answer = [...requestCard!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === (kind === 'question' ? 'Stable' : 'Allow once'))!
  expect(answer.disabled).toBe(false)
  await act(async () => answer.click())
  expect(response).toHaveBeenCalledExactlyOnceWith(running.control, kind === 'question'
    ? { kind, requestId: request.id, outcome: 'answered', answers: [{ questionId: 'channel', optionId: 'stable' }] }
    : { kind, requestId: request.id, decision: { outcome: 'selected', optionId: 'once' } })
  expect(answer.disabled).toBe(true)
  expect(useAppStore.getState().sessions).toEqual([running, healthy])
  expect(panel()?.textContent).toContain(running.status.detail)
  expect(api.sessions.stop).not.toHaveBeenCalled(); retained()
  const { pendingInteraction: _answered, ...answered } = running
  await act(async () => useAppStore.setState({ sessions: [answered, healthy] }))
  expect(panel()?.textContent).toContain(running.status.detail)
  expect(panel()?.textContent).not.toContain('All caught up')
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(running.id)
})
it('keeps a replacement Run after an old close, ignores late completion/removal, and does not infer retirement from an unavailable projection', async () => {
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve }); vi.mocked(api.sessions.stop).mockReturnValueOnce(pending)
  await mountReview(); await clickClose()
  const replacement = { ...failed, processState: 'running' as const, control: { ...failed.control, run: { runId: 'replacement-run' } } }
  await act(async () => useAppStore.setState({ sessions: [replacement, healthy] }))
  expect(panel()?.textContent).toContain('current Session was kept'); expect(closeButton()).toBeUndefined()
  await publish(removal()); await act(async () => { release(); await pending })
  expect(useAppStore.getState().sessions).toEqual([replacement, healthy]); expect(panel()?.textContent).not.toContain('Core confirmed')
  await act(async () => useAppStore.setState({ sessions: [healthy] }))
  expect(panel()?.textContent).toContain('close has not been confirmed'); expect(panel()?.textContent).not.toContain('Core confirmed'); retained()
})
it('closing the request panel only removes presentation, releases its observer and leaves the failed Session and neighbors intact', async () => {
  await mountReview(); expect(listeners.size).toBe(1)
  await act(async () => panel()!.querySelector<HTMLButtonElement>('[aria-label="Close request"]')!.click())
  expect(panel()).toBeNull(); expect(listeners.size).toBe(0); expect(api.sessions.stop).not.toHaveBeenCalled(); expect(useAppStore.getState().sessions).toEqual([failed, healthy]); retained()
  // Standalone ordinary Attention keeps the existing request path and adds no retirement observer.
  await act(async () => root.render(createElement(AttentionRequestPanel, { sessionId: healthy.id, onClose: vi.fn() })))
  expect(listeners.size).toBe(0); expect(closeButton()).toBeUndefined()
})
it('rechecks the current Run before a stale painted close button can submit control', async () => {
  await mountReview(); const paintedClose = closeButton()!
  const replacement = { ...failed, control: { ...failed.control, run: { runId: 'new-ended-run' } } }
  await act(async () => { useAppStore.setState({ sessions: [replacement, healthy] }); paintedClose.click() })
  expect(api.sessions.stop).not.toHaveBeenCalled(); expect(useAppStore.getState().sessions).toEqual([replacement, healthy]); retained()
})
