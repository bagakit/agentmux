// @vitest-environment happy-dom
import { act, createElement, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentTimelineSnapshot } from '@agentmux/core'
import { agentActivityRemainingMs } from '@agentmux/core/agent-status'
import { observeAgentSession } from '../src/renderer/src/lib/agent-observation'
import { useAgentStatusDecay, nextAgentStatusDecayDelayMs } from '../src/renderer/src/lib/agent-status-decay'
import type { SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { FocusContextStateMark } from '../src/renderer/src/components/FocusContextState'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { seedMoteWorkface } from './fixtures/mote-workface'
vi.mock('../src/renderer/src/components/PmoTeamsTopicEntry', () => ({ PmoTeamsTopicEntry: () => createElement('button', null, 'PMO') }))
import { SurfaceSwitch } from '../src/renderer/src/components/TopRowChrome'
const baseline = useAppStore.getState()
let root: Root, container: HTMLDivElement
const commits = vi.fn()
const preview = () => document.querySelector<HTMLElement>('#surface-navigation-tooltip-focus')
const focus = () => container.querySelector<HTMLButtonElement>('button[aria-label^="Focus: show execution contexts."]')!
const hover = () => act(async () => { focus().dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); vi.advanceTimersByTime(150) })
const leave = () => act(async () => focus().dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })))
const agent = (id: string, state: SessionSnapshot['status']['state']) => ({ ...composerSession(id), status: { state, source: 'native-hook' as const, observedAt: Date.now() } })
function timeline(id: string, kind: 'user_message' | 'assistant_message', content: string): AgentTimelineSnapshot {
  return { agentSessionId: id, sourceHostId: 'local', revision: 1, items: [{ id: `${id}-item`, agentSessionId: id, source: 'native-hook', kind, status: 'complete', title: 'Record', content, createdAt: Date.now(), updatedAt: Date.now() }] }
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  useAppStore.setState({ config: composerConfig, mainSurface: 'workbench', agentNames: { working: 'Build the parser', attention: 'Review the change', result: 'Ready for review', unknown: 'Previous Agent' },
    sessions: [agent('working', 'working'), { ...agent('attention', 'waiting'), pendingInteraction: { kind: 'permission', id: 'request', title: 'Allow access to the selected project?', operation: 'read' } as never }, agent('result', 'done'), agent('unknown', 'running'), { ...agent('interrupted', 'working'), processState: 'interrupted' }],
    timelines: { working: timeline('working', 'user_message', 'Compile the parser'), result: timeline('result', 'assistant_message', 'Parser tests pass'), attention: timeline('attention', 'assistant_message', 'Old reply must not hide the request') },
    scratchTopicSnapshots: {}, agentComposerDrafts: { unknown: 'Keep the original draft' },
    agentFocus: { execution: { sessionId: 'unknown', history: [] }, pmo: { sessionId: null } } })
  commits.mockClear(); await act(async () => root.render(<Profiler id="navigation" onRender={commits}><SurfaceSwitch /></Profiler>))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.getElementById('agentmux-window-overlay-host')?.remove(); useAppStore.setState(baseline, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

it('prioritizes real attention over execution MRU and uses the standard read-only face and group glyphs', async () => {
  const before = useAppStore.getState(), source = vi.spyOn(api.sessions, 'historySources'), page = vi.spyOn(api.sessions, 'historyPage'), appearance = vi.spyOn(api.workspaces, 'appearance')
  expect(preview()).toBeNull(); await hover(); expect(preview()?.getAttribute('role')).toBe('tooltip')
  expect([...preview()!.querySelectorAll('[data-preview-session]')].map(row => row.getAttribute('data-preview-session'))).toEqual(['attention', 'working', 'result'])
  expect(preview()?.textContent).not.toContain('Focused'); expect(preview()?.textContent).not.toContain('Old reply must not hide the request')
  expect(preview()?.textContent).toContain('Allow access to the selected project?'); expect(preview()?.textContent).toContain('Parser tests pass')
  expect(preview()?.textContent).toContain(composerConfig.workspaces[0]!.name); expect(preview()?.textContent).toContain('2 more')
  expect(preview()?.querySelector('[data-preview-count="idle"] [data-semantic-icon="status.neutral"]')).not.toBeNull()
  expect(preview()?.querySelector('[data-preview-session="attention"] .focus-context__state [data-semantic-icon="status.needs-input"]')).not.toBeNull()
  expect(preview()?.querySelector('[data-preview-session] [data-executor-id="codex"]')).not.toBeNull()
  expect(preview()?.querySelector('button, input, [tabindex]')).toBeNull(); expect(focus().hasAttribute('title')).toBe(false)
  expect(source).not.toHaveBeenCalled(); expect(page).not.toHaveBeenCalled(); expect(appearance).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions).toBe(before.sessions); expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})
it.each(['working', 'waiting', 'error', 'unknown', 'unsupported', 'interrupted', 'unobserved', 'disconnected'] as const)('keeps the actual footer %s mark identical to the shared Agent card mark', async kind => {
  const base = agent(kind, kind === 'waiting' ? 'waiting' : kind === 'error' ? 'error' : kind === 'disconnected' ? 'disconnected' : kind === 'working' || kind === 'interrupted' ? 'working' : 'running')
  const session = { ...base, ...(kind === 'unsupported' ? { capabilities: { ...base.capabilities, timeline: 'unavailable' as const } } : {}), ...(kind === 'interrupted' || kind === 'unobserved' || kind === 'disconnected' ? { processState: 'interrupted' as const } : {}), ...(kind === 'unobserved' ? { runUnobserved: true as const } : {}) }
  await act(async () => useAppStore.setState({ sessions: [session], timelines: {} })); await hover()
  const context = agentContextForSession(session, undefined, kind, composerConfig.workspaces[0], null)
  await act(async () => root.render(<><SurfaceSwitch /><div data-card-reference><FocusContextStateMark context={context} /></div></>))
  const expected = { working: 'status.working', waiting: 'status.needs-input', error: 'status.failed', unknown: 'status.activity-unknown', unsupported: 'status.activity-unknown', interrupted: 'status.interrupted', unobserved: 'status.presence-unknown', disconnected: 'status.interrupted' }[kind]
  // Replacing the tree above creates a new footer owner; explicitly focus its original trigger.
  await act(async () => focus().focus())
  expect(preview()?.querySelector('[data-preview-session] .focus-state-mark [data-semantic-icon]')?.getAttribute('data-semantic-icon')).toBe(expected)
  expect(container.querySelector('[data-card-reference] [data-semantic-icon]')?.getAttribute('data-semantic-icon')).toBe(expected)
  expect(preview()?.querySelector('[data-preview-session]')?.getAttribute('aria-label')).toContain(context.stateLabel)
})
it('separates working, pending request and real error counts with their current shared glyphs', async () => {
  await act(async () => useAppStore.setState(state => ({ sessions: [...state.sessions, { ...agent('failure', 'error'), status: { ...agent('failure', 'error').status, detail: 'Model request failed' } }] })))
  for (const [count, glyph] of [['working', 'status.working'], ['requests', 'status.needs-input'], ['errors', 'status.failed']]) {
    const slot = focus().querySelector(`[data-focus-count="${count}"]`)!; expect(slot.textContent).toBe('1'); expect(slot.querySelector(`[data-semantic-icon="${glyph}"]`)).not.toBeNull()
  }
  expect(focus().getAttribute('aria-label')).toContain('1 failed'); await hover(); expect(preview()?.textContent).toContain('Model request failed')
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'failure' ? { ...session, pendingInteraction: { kind: 'permission', id: 'failed-request', title: 'Allow the original operation?', operation: 'read' } as never } : session) })))
  expect(focus().querySelector('[data-focus-count="requests"]')?.textContent).toBe('2')
  expect(focus().querySelector('[data-focus-count="errors"]')?.textContent).toBe('1')
  expect(preview()?.querySelector('[data-preview-count="attention"] b')?.textContent).toBe('2')
})
it('ignores unrelated bytes and detaches detailed projection when closed', async () => {
  await hover(); const before = commits.mock.calls.length
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(s => ({ ...s, latestOutputBytes: s.latestOutputBytes + 128 })) })))
  expect(commits.mock.calls.length).toBe(before); await leave(); const closed = commits.mock.calls.length
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, working: timeline('working', 'assistant_message', 'Changed while closed') } })))
  expect(commits.mock.calls.length).toBe(closed); await hover(); expect(preview()?.textContent).toContain('Changed while closed')
})
it('keeps explicit navigation and cancels pointer intent on activation, Escape, blur and document hiding', async () => {
  const before = useAppStore.getState()
  await act(async () => { focus().dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); focus().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); focus().focus(); focus().click(); vi.advanceTimersByTime(300) })
  expect(preview()).toBeNull(); expect(useAppStore.getState().mainSurface).toBe('agents'); expect(useAppStore.getState().agentFocus).toBe(before.agentFocus)
  for (const dismiss of [() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })), () => window.dispatchEvent(new Event('blur')), () => { vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')) }]) {
    await leave(); await act(async () => { focus().dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); dismiss(); vi.advanceTimersByTime(300) }); expect(preview()).toBeNull()
  }
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})
it('retains interrupted and unobserved contexts in the original neutral group and updates actual accepted detail', async () => {
  const interrupted = useAppStore.getState().sessions.find(s => s.id === 'interrupted')!
  await act(async () => useAppStore.setState({ sessions: [interrupted], timelines: {} })); await hover()
  expect(preview()?.querySelector('[data-preview-session="interrupted"]')).not.toBeNull(); expect(preview()?.textContent).toContain('Run interrupted')
  await act(async () => useAppStore.setState({ sessions: [{ ...interrupted, runUnobserved: true }] }))
  expect(preview()?.textContent).toContain('Run not observed'); expect(preview()?.querySelector('[data-semantic-icon="status.presence-unknown"]')).not.toBeNull()
})
it('uses the original confirmed PMO membership and preserves truthful empty navigation', async () => {
  await act(async () => { seedMoteWorkface(); useAppStore.setState(state => ({ sessions: state.sessions.map(session => ({ ...session, status: { ...session.status, observedAt: Date.now() } })) })) }); await hover()
  expect([...preview()!.querySelectorAll('[data-preview-session]')].map(row => row.getAttribute('data-preview-session'))).toEqual(['ordinary-agent', 'execution-agent'])
  expect(focus().querySelector('[data-focus-count="working"]')?.textContent).toBe('2')
  await act(async () => useAppStore.setState({ sessions: [], timelines: {} }))
  expect(preview()?.textContent).toContain('0 contexts'); expect(preview()?.textContent).toContain('No execution contexts yet')
  await act(async () => focus().click()); expect(useAppStore.getState().mainSurface).toBe('agents'); expect(preview()).toBeNull()
})

function OriginalStatusOwner() { useAgentStatusDecay(); return null }
it('expires native activity through the original window owner without changing facts or polling after expiry', async () => {
  const original = agent('native-current', 'running'), neighbor = agent('unchanged-neighbor', 'running'), observedAt = Date.now()
  const session = { ...original, currentActivity: { state: 'active' as const, source: 'native-hook' as const, run: original.control.run,
    nativeSessionId: 'native-current', nativeTurnId: 'turn-current', sourceId: 'source-current', sequence: 1, hookReceiptId: 'receipt-current', observedAt } }
  await act(async () => useAppStore.setState({ sessions: [session, neighbor], timelines: {} }))
  await act(async () => root.render(<Profiler id="navigation" onRender={commits}><OriginalStatusOwner /><SurfaceSwitch /></Profiler>))
  await act(async () => focus().focus())
  expect(focus().querySelector('[data-focus-count="working"]')?.textContent).toBe('1')
  const delay = agentActivityRemainingMs(observeAgentSession(session, observedAt), observedAt); expect(delay).toBeGreaterThan(0)
  await act(async () => vi.advanceTimersByTime(delay - 1)); expect(focus().querySelector('[data-focus-count="working"]')).not.toBeNull()
  const newer = { ...session, currentActivity: { ...session.currentActivity, sequence: 2, observedAt: Date.now() } }
  await act(async () => useAppStore.setState({ sessions: [newer, neighbor] }))
  await act(async () => vi.advanceTimersByTime(2)); expect(focus().querySelector('[data-focus-count="working"]')).not.toBeNull()
  const remaining = agentActivityRemainingMs(observeAgentSession(newer, Date.now()), Date.now())
  await act(async () => vi.advanceTimersByTime(remaining))
  expect(focus().querySelector('[data-focus-count="working"]')).toBeNull()
  expect(preview()?.querySelector('[data-preview-session="native-current"] [data-semantic-icon="status.activity-unknown"]')).not.toBeNull()
  expect(useAppStore.getState().sessions[0]).not.toBe(newer); expect(useAppStore.getState().sessions[0]!.status).toBe(newer.status)
  expect(useAppStore.getState().sessions[0]!.currentActivity).toBe(newer.currentActivity); expect(useAppStore.getState().sessions[0]!.control).toBe(newer.control)
  expect(useAppStore.getState().sessions[1]).toBe(neighbor)
  expect(nextAgentStatusDecayDelayMs(useAppStore.getState().sessions, Date.now())).toBeNull()
  const rendered = commits.mock.calls.length; await act(async () => vi.advanceTimersByTime(delay * 2)); expect(commits.mock.calls.length).toBe(rendered)
})
