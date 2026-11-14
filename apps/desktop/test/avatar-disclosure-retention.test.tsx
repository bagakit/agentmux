// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Root } from 'react-dom/client'
import { DEFAULT_AGENT_CONTINUITY_POLICY, type AgentMuxContinuityOperation } from '@agentmux/core/agent-session-recovery'
import type { AgentMuxAgentSession } from '@agentmux/core'
import { AgentAvatar } from '../src/renderer/src/components/AgentAvatar'
import { createClientUiRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { useAppStore } from '../src/renderer/src/store'

const original = useAppStore.getState(), registry = new FinalizationRegistry<{ collected: boolean }>(observation => { observation.collected = true })
let root: Root, host: HTMLDivElement
const pause = () => new Promise(resolve => setTimeout(resolve, 15))
async function collect() { for (let n = 0; n < 15; n++) { globalThis.gc!(); await pause() } }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.body.appendChild(document.createElement('div')); root = createClientUiRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); document.getElementById('agentmux-window-overlay-host')?.remove()
  useAppStore.setState(original, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function seed() {
  const session = composerSession('avatar-retention'), key = { kind: 'message' as const, agentSessionId: session.id, expectedRun: session.control.run, messageId: 'original-message' }
  const operation: AgentMuxContinuityOperation = { operationId: 'avatar-original-input', agentSessionId: session.id, trigger: 'startup',
    policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY }, previousRun: session.control.run, admittedAt: 1, observedAt: 2, rechecks: 0,
    kind: 'pending', reason: 'operation-unconfirmed', evidence: { kind: 'run-running', observedAt: 2 },
    messageInput: { ref: { key, waitGeneration: 1 }, key, admissionIntent: { kind: 'session-conversation', expectedRun: session.control.run },
      prompt: 'Original input', message: { userContent: 'Original frozen composed body'.repeat(40000), authorHuman: true }, lifecycleOperationId: 'original-lifecycle' } }
  const core: AgentMuxAgentSession = { kind: 'agent', agentSessionId: session.id, providerId: session.providerId, executorId: session.executorId,
    hostId: session.hostId, workspacePath: session.workspacePath, run: session.control.run, retiredRuns: [], createdAt: 1, updatedAt: 2, continuity: operation }
  useAppStore.setState({ config: composerConfig, sessions: [session], timelines: {}, recoveryCandidates: [], pendingAgentLaunches: {},
    agentComposerDrafts: { [session.id]: 'Keep original unsent draft' }, runtimeEndpointWarnings: [] })
  useAppStore.getState().applyEvent({ type: 'core', hostId: session.hostId, event: { type: 'agent-session', session: core } })
  const owned = useAppStore.getState().sessions[0]!, observation = { collected: false }
  if (owned.kind !== 'agent' || !owned.continuity?.messageInput) throw Error('The real Store must isolate the original complete input')
  registry.register(owned.continuity.messageInput.message, observation)
  const { continuity: _continuity, ...clear } = core
  return { session, observation, clear }
}
function originalScene(opened: string[]) {
  const session = useAppStore.getState().sessions[0]!
  // Same public onOpen capture shape as FocusTimeTrack: a real current Session in a caller closure.
  return <AgentAvatar sessionId={session.id} label="Original retained avatar" onOpen={() => opened.push(session.control.run.runId)}
    disclosure={{ label: 'Original context', scope: 'original-context', content: <p>Original preview</p>, reference: () => ({ getBoundingClientRect: () => new DOMRect(20, 20, 20, 20) }) }} />
}
it('actual Store and mounted Avatar release the obsolete input captured by an old onOpen caller without replacing the trigger', async () => {
  expect(globalThis.gc).toBeTypeOf('function')
  const trace = Error.stackTraceLimit; Error.stackTraceLimit = 0
  try {
    const { session, observation, clear } = seed(), opened: string[] = []
    await act(async () => root.render(originalScene(opened)))
    const trigger = host.querySelector<HTMLButtonElement>('.agent-avatar')!
    for (let n = 0; n < 5; n++) await act(async () => {
      useAppStore.getState().applyEvent({ type: 'core', hostId: session.hostId, event: { type: 'agent-session', session: { ...clear, updatedAt: 3 + n } } })
      root.render(originalScene(opened))
    })
    expect(host.querySelector('.agent-avatar')).toBe(trigger)
    expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Keep original unsent draft')
    expect(useAppStore.getState().sessions[0]?.control).toEqual(session.control)
    await collect(); expect(observation.collected, 'Mounted Document/timer effects must release the obsolete caller Session').toBe(true)
    await act(async () => trigger.click()); expect(opened).toEqual([session.control.run.runId])
  } finally { Error.stackTraceLimit = trace }
})
function preview(label = 'Original preview', scope = 'original-context') {
  return { label: 'Original context', scope, content: <p>{label}</p>, reference: () => ({ getBoundingClientRect: () => new DOMRect(20, 20, 20, 20) }) }
}
it('same-scope Avatar updates preserve listeners, trigger, text selection and latest navigation while original dismissal stays live', async () => {
  const originalOpen = vi.fn(), currentOpen = vi.fn()
  const scene = (current = false) => <><input defaultValue="Original authored input" /><AgentAvatar label="Original avatar"
    onOpen={current ? currentOpen : originalOpen} disclosure={preview(current ? 'Current preview' : 'Original preview')} /></>
  await act(async () => root.render(scene()))
  const trigger = host.querySelector<HTMLButtonElement>('.agent-avatar')!, input = host.querySelector('input')!
  input.focus(); input.setSelectionRange(3, 9)
  const add = vi.spyOn(document, 'addEventListener'), remove = vi.spyOn(document, 'removeEventListener')
  await act(async () => root.render(scene(true)))
  expect(host.querySelector('.agent-avatar')).toBe(trigger); expect(host.querySelector('input')).toBe(input)
  expect(input.value).toBe('Original authored input'); expect([input.selectionStart, input.selectionEnd]).toEqual([3, 9])
  for (const type of ['visibilitychange', 'pointerdown', 'keydown']) {
    expect(add.mock.calls.filter(call => call[0] === type)).toHaveLength(0)
    expect(remove.mock.calls.filter(call => call[0] === type)).toHaveLength(0)
  }
  const opened = () => document.querySelector('.recent-focus__context-preview')
  async function show() {
    await act(async () => trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })))
    expect(opened()).toBeNull()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 210)) })
    expect(opened()?.textContent).toBe('Current preview')
  }
  await show()
  await act(async () => trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))); expect(opened()).not.toBeNull()
  await act(async () => opened()!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))); expect(opened()).not.toBeNull()
  const prevented = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); prevented.preventDefault()
  await act(async () => document.dispatchEvent(prevented)); expect(opened()).not.toBeNull()
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); expect(opened()).toBeNull()
  await show(); await act(async () => input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))); expect(opened()).toBeNull()
  await show()
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  await act(async () => document.dispatchEvent(new Event('visibilitychange'))); expect(opened()).toBeNull(); visibility.mockRestore()
  await act(async () => trigger.click()); expect(currentOpen).toHaveBeenCalledOnce(); expect(originalOpen).not.toHaveBeenCalled()
  expect([input.selectionStart, input.selectionEnd]).toEqual([3, 9])
})
it('scope retirement and unmount cancel the original delayed disclosure timers', async () => {
  vi.useFakeTimers()
  try {
    const scene = (scope: string) => <AgentAvatar label="Original avatar" onOpen={() => {}} disclosure={preview('Preview', scope)} />
    await act(async () => root.render(scene('first-scope')))
    const baseline = vi.getTimerCount(), trigger = host.querySelector('.agent-avatar')!
    await act(async () => trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })))
    expect(vi.getTimerCount()).toBe(baseline + 1)
    await act(async () => root.render(scene('next-scope'))); expect(vi.getTimerCount()).toBe(baseline)
    await act(async () => trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })))
    expect(vi.getTimerCount()).toBe(baseline + 1)
    await act(async () => root.render(null)); expect(vi.getTimerCount()).toBe(baseline)
    await act(async () => vi.runAllTimers()); expect(document.querySelector('.recent-focus__context-preview')).toBeNull()
  } finally { vi.useRealTimers() }
})
