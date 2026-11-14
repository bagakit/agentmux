// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxAgentStopReceipt } from '@agentmux/core'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { AgentOperationFeedback } from '../src/renderer/src/components/AgentOperationFeedback'
import { agentOperationKey, beginAgentOperation, inspectAgentOperation, settleAgentCreation, type AgentOperationFeedback as Operation } from '../src/renderer/src/lib/agent-operation-feedback'
import { agentOperationsForSubject, persistedAgentOperations, restoredAgentOperations } from '../src/renderer/src/lib/agent-operation'
import { stopSessionInBackground } from '../src/renderer/src/lib/session-stop-background'

const initial = useAppStore.getState(), session = composerSession('operation-source')
const subject = { hostId: session.control.hostId, agentSessionId: session.control.agentSessionId }
const operation = (id: string): Operation => ({ kind: 'stop', operationId: id, control: session.control, subject, phase: 'pending', startedAt: 1 })
let root: Root, container: HTMLDivElement
const receipt = (id: string): AgentMuxAgentStopReceipt => ({ agentSessionId: session.control.agentSessionId, expectedRun: session.control.run,
  operationId: id, lifecycleOperationId: `lifecycle-${id}`, admission: 'new', retiredAt: 7,
  runtime: { observed: 'running', stop: 'graceful' }, stages: [] })
const render = () => act(async () => root.render(<div className="focus-context-card"><button>Original Agent</button><AgentOperationFeedback subject={subject} /></div>))

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) { this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
    disconnect() {}
  })
  useAppStore.setState({ ...initial, config: composerConfig, sessions: [session], agentOperations: {}, error: null }, true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
  vi.restoreAllMocks(); vi.unstubAllGlobals(); useAppStore.setState(initial, true)
})

it('a hanging original Stop is shared across consumers, keeps reading, and settles only from its matching receipt', async () => {
  let resolve!: (value: AgentMuxAgentStopReceipt) => void
  const stop = vi.spyOn(api.sessions, 'stop').mockImplementation(() => new Promise(done => { resolve = done }))
  const intent = { control: session.control, operationId: 'one-stop' }
  let sent!: Promise<boolean>
  await act(async () => { sent = stopSessionInBackground(intent) })
  await render()
  expect(container.textContent).toContain('停止中')
  expect(container.querySelector('button')?.textContent).toBe('Original Agent')
  expect(container.querySelector('[data-motion-active="true"]')).not.toBeNull()
  expect(stopSessionInBackground(intent)).toBe(sent)
  expect(stop).toHaveBeenCalledExactlyOnceWith(session.control, 'one-stop')
  await act(async () => { resolve(receipt('one-stop')); await sent })
  expect(useAppStore.getState().sessions).toEqual([session])
  expect(container.textContent).not.toContain('停止中')
})

it('restored references remain static and checking the original Stop cannot send it again', async () => {
  const original = operation('retained-stop')
  const refs = restoredAgentOperations({ [agentOperationKey(original)]: original })
  const stop = vi.spyOn(api.sessions, 'stop')
  const inspect = vi.spyOn(api.sessions, 'inspectStop').mockResolvedValue({ agentSessionId: subject.agentSessionId,
    expectedRun: session.control.run, phase: 'unconfirmed', canRetry: false, operationIdMatched: true, observedAt: 8 })
  useAppStore.setState({ agentOperations: refs })
  await render()
  expect(container.textContent).toContain('停止未确认')
  expect(container.querySelector('[data-motion-active="true"]')).toBeNull()
  expect(inspect).not.toHaveBeenCalled()
  await act(async () => { await inspectAgentOperation(original) })
  expect(inspect).toHaveBeenCalledExactlyOnceWith(session.control, original.operationId)
  expect(stop).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentOperations[agentOperationKey(original)]?.phase).toBe('unconfirmed')
})

it('a wrong original receipt cannot turn a healthy source into a completed Stop', async () => {
  vi.spyOn(api.sessions, 'stop').mockResolvedValue({ ...receipt('expected'), expectedRun: { runId: 'later-run' } })
  await act(async () => { expect(await stopSessionInBackground({ control: session.control, operationId: 'expected' })).toBe(false) })
  expect(Object.values(useAppStore.getState().agentOperations).map(item => item.phase)).toEqual(['unconfirmed'])
  expect(useAppStore.getState().sessions).toEqual([session])
})

it('Core retained/joined Stop receipts retain their canonical operation and the caller provenance', async () => {
  vi.spyOn(api.sessions, 'stop').mockResolvedValue({ ...receipt('original-core-stop'), admission: 'retained' })
  await act(async () => { expect(await stopSessionInBackground({ control: session.control, operationId: 'caller-stop' })).toBe(true) })
  const references = Object.values(useAppStore.getState().agentOperations)
  expect(references).toHaveLength(1)
  expect(references[0]).toMatchObject({ phase: 'succeeded', operationId: 'original-core-stop', callerOperationIds: ['caller-stop'] })
})

it.each(['stopping', 'error'] as const)('a late %s inspection cannot overwrite a confirmed original Stop', async outcome => {
  const original = operation(`late-${outcome}`)
  beginAgentOperation(original)
  let resolve!: (value: Awaited<ReturnType<typeof api.sessions.inspectStop>>) => void, reject!: (error: Error) => void
  vi.spyOn(api.sessions, 'inspectStop').mockImplementation(() => new Promise((done, fail) => { resolve = done; reject = fail }))
  const inspecting = inspectAgentOperation(original)
  vi.spyOn(api.sessions, 'stop').mockResolvedValue(receipt(original.operationId))
  await act(async () => { await stopSessionInBackground({ control: session.control, operationId: original.operationId }) })
  await act(async () => {
    if (outcome === 'error') reject(new Error('old read failed'))
    else resolve({ agentSessionId: subject.agentSessionId, expectedRun: session.control.run, phase: 'stopping', canRetry: true, operationIdMatched: true, observedAt: 1 })
    await inspecting
  })
  expect(useAppStore.getState().agentOperations[agentOperationKey(original)]?.phase).toBe('succeeded')
})

it('hiding the workface pauses motion while retaining its original pending state and reading', async () => {
  beginAgentOperation(operation('hide-operation'))
  await render()
  expect(container.querySelector('[data-motion-active="true"]')).not.toBeNull()
  const status = container.querySelector('[role="status"]')!
  expect(status.textContent).toBe('停止中')
  expect(container.querySelector('summary')!.textContent).toBe('停止中')
  expect(status.getAttribute('data-text')).toBe(status.textContent)
  expect(container.querySelector('.agent-operation-feedback__motion')).toBeNull()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(container.querySelector('[data-motion-active="true"]')).toBeNull()
  expect(container.textContent).toContain('停止中')
  expect(Object.values(useAppStore.getState().agentOperations)).toHaveLength(1)
})

it('explicit Continue reaches Core on the same operation while its earlier reader is still waiting', async () => {
  let release!: (value: AgentMuxAgentStopReceipt) => void
  const stop = vi.spyOn(api.sessions, 'stop').mockImplementationOnce(() => new Promise(done => { release = done }))
    .mockResolvedValueOnce(receipt('pending-reader'))
  vi.spyOn(api.sessions, 'inspectStop').mockResolvedValue({ agentSessionId: subject.agentSessionId,
    expectedRun: session.control.run, phase: 'stopping', canRetry: true, operationIdMatched: true, observedAt: 8 })
  let first!: Promise<boolean>
  await act(async () => { first = stopSessionInBackground({ control: session.control, operationId: 'pending-reader' }) })
  await render()
  const original = Object.values(useAppStore.getState().agentOperations)[0]!
  await act(async () => { await inspectAgentOperation(original) })
  const button = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('继续同次停止'))
  expect(button).toBeDefined()
  await act(async () => { button!.click() })
  expect(stop.mock.calls).toEqual([[session.control, 'pending-reader'], [session.control, 'pending-reader']])
  await act(async () => { release(receipt('pending-reader')); await first })
  expect(useAppStore.getState().sessions).toEqual([session])
})

it('operation indexing retains exact Host subjects and is stable during unrelated Session updates', async () => {
  const local = operation('same-id'), other: Operation = { ...local, subject: { ...subject, hostId: 'other-host' }, control: { ...session.control, hostId: 'other-host' } }
  beginAgentOperation(local); beginAgentOperation(other)
  const refs = useAppStore.getState().agentOperations, selected = agentOperationsForSubject(refs, subject)
  expect(selected).toEqual([local])
  useAppStore.setState({ sessions: [...useAppStore.getState().sessions, composerSession('unrelated')] })
  expect(agentOperationsForSubject(useAppStore.getState().agentOperations, subject)).toBe(selected)
  expect(agentOperationsForSubject(refs, other.subject)).toEqual([other])
})

it('only unresolved original references survive restart; confirmed success does not become a new warning', () => {
  const unresolved = operation('unresolved'), done = { ...operation('confirmed'), phase: 'succeeded' as const }
  const operations = { [agentOperationKey(unresolved)]: unresolved, [agentOperationKey(done)]: done }
  const retained = persistedAgentOperations(operations)
  expect(Object.values(retained)).toEqual([unresolved])
  expect(persistedAgentOperations(operations)).toBe(retained)
  expect(Object.values(restoredAgentOperations(retained)).map(item => item.phase)).toEqual(['unconfirmed'])
})

it('partial creation preserves its real result and does not mark or remove the source Agent', async () => {
  const fork: Operation = { kind: 'fork', operationId: 'one-fork', subject, phase: 'pending', startedAt: 1 }
  beginAgentOperation(fork)
  const report = { requestId: fork.operationId, outcome: 'partial' as const, from: null, to: null,
    agent: { agentSessionId: 'real-created-agent', hostId: 'local', runId: 'real-created-run' },
    resource: null, save: {}, issues: [{ step: 'save', code: 'SAVE_UNKNOWN', message: 'Save unconfirmed', recovery: 'inspect' }] } as unknown as NonNullable<Operation['report']>
  settleAgentCreation(fork, report)
  await render()
  expect(container.textContent).toContain('Fork部分完成')
  expect(container.textContent).toContain('real-created-agent')
  expect(container.querySelector('[data-motion-active="true"]')).toBeNull()
  expect(useAppStore.getState().sessions).toEqual([session])
  expect(useAppStore.getState().agentOperations[agentOperationKey(fork)]?.report).toBe(report)
  const retired = { ...report, outcome: 'retired' as const }
  await act(async () => { settleAgentCreation(fork, retired) })
  expect(container.textContent).toContain('Fork目标已关闭')
  await act(async () => { settleAgentCreation(fork, { ...report, outcome: 'opened' }) })
  expect(useAppStore.getState().agentOperations[agentOperationKey(fork)]?.phase).toBe('retired')
  expect(useAppStore.getState().agentOperations[agentOperationKey(fork)]?.report).toBe(retired)
})

async function openCompactDetail() {
  const trigger = container.querySelector<HTMLButtonElement>('.agent-operation-feedback--compact button.agent-operation-feedback__label')!
  expect(trigger, 'the compact status is a real button').not.toBeNull()
  await act(async () => { trigger.click() })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  return trigger
}

it('compact operation details open in the maintained non-modal Portal and Escape returns to the original status', async () => {
  const original = { ...operation('compact-original'), phase: 'unconfirmed' as const, canContinue: true }
  beginAgentOperation(original)
  const inspect = vi.spyOn(api.sessions, 'inspectStop').mockResolvedValue({ agentSessionId: subject.agentSessionId,
    expectedRun: session.control.run, phase: 'stopping', canRetry: true, operationIdMatched: true, observedAt: 8 })
  const stop = vi.spyOn(api.sessions, 'stop')
  await act(async () => root.render(<div><input aria-label="Original draft" defaultValue="Keep reading" /><AgentOperationFeedback subject={subject} compact /></div>))
  expect(document.querySelector('.agent-operation-feedback__popover')).toBeNull()
  const trigger = await openCompactDetail()
  const panel = document.querySelector<HTMLElement>('.agent-operation-feedback__popover')!
  expect(panel).not.toBeNull()
  expect(container.contains(panel)).toBe(false)
  expect(panel.getAttribute('role')).toBe('dialog')
  expect(panel.getAttribute('aria-modal')).not.toBe('true')
  expect(panel.style.visibility).toBe('visible')
  expect(document.activeElement).toBe(panel)
  expect(panel.textContent).toContain(original.operationId)
  expect(panel.querySelector('button')?.closest('summary')).toBeNull()
  const check = [...panel.querySelectorAll('button')].find(button => button.textContent?.includes('核对原操作'))!
  await act(async () => { check.click() })
  expect(inspect).toHaveBeenCalledExactlyOnceWith(session.control, original.operationId)
  expect(stop).not.toHaveBeenCalled()
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  expect(document.querySelector('.agent-operation-feedback__popover')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  expect(useAppStore.getState().agentOperations[agentOperationKey(original)]?.phase).toBe('pending')
})

it('compact operation details dismiss outside without taking later input focus or losing the original unresolved operation', async () => {
  const original = { ...operation('compact-outside'), phase: 'unconfirmed' as const }
  beginAgentOperation(original)
  await act(async () => root.render(<div><input aria-label="Later draft" defaultValue="Later input stays here" /><AgentOperationFeedback subject={subject} compact /></div>))
  await openCompactDetail()
  expect(document.querySelector('.agent-operation-feedback__popover')).not.toBeNull()
  const input = container.querySelector('input')!
  await act(async () => {
    input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    input.focus()
    input.setSelectionRange(6, 11)
    input.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }))
    input.click()
  })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  expect(document.querySelector('.agent-operation-feedback__popover')).toBeNull()
  expect(document.activeElement).toBe(input)
  expect(input.value).toBe('Later input stays here')
  expect([input.selectionStart, input.selectionEnd]).toEqual([6, 11])
  expect(useAppStore.getState().agentOperations[agentOperationKey(original)]).toBe(original)
})

it('closing compact details keeps later input focus while Escape return-focus is queued', async () => {
  const original = { ...operation('compact-later-focus'), phase: 'unconfirmed' as const }
  beginAgentOperation(original)
  await act(async () => root.render(<div><input aria-label="Later input" defaultValue="Keep my new selection" /><AgentOperationFeedback subject={subject} compact /></div>))
  await openCompactDetail()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(document.querySelector('.agent-operation-feedback__popover')).toBeNull()
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    const input = container.querySelector('input')!
    input.focus(); input.setSelectionRange(8, 11)
    await act(async () => { await vi.runAllTimersAsync() })
    expect(document.activeElement).toBe(input)
    expect([input.selectionStart, input.selectionEnd]).toEqual([8, 11])
    expect(useAppStore.getState().agentOperations[agentOperationKey(original)]).toBe(original)
  } finally { vi.useRealTimers() }
})

it('an open compact result survives sibling decoration completion until its last reader closes it', async () => {
  const fork: Operation = { kind: 'fork', operationId: 'compact-reading-result', subject, phase: 'pending', startedAt: 1 }
  beginAgentOperation(fork)
  await act(async () => root.render(<><div className="focus-context-card"><AgentOperationFeedback subject={subject} /></div><AgentOperationFeedback subject={subject} compact /></>))
  const inline = container.querySelector<HTMLDetailsElement>('.focus-context-card details')!
  await act(async () => { inline.querySelector('summary')!.click() })
  expect(inline.open).toBe(true)
  expect(inline.querySelector('summary button')).toBeNull()
  await openCompactDetail()
  const report = { requestId: fork.operationId, outcome: 'opened', from: null, to: null,
    agent: { agentSessionId: 'created-while-reading', hostId: 'local', runId: 'created-run' }, resource: null, save: {}, issues: [] } as unknown as NonNullable<Operation['report']>
  await act(async () => { settleAgentCreation(fork, report) })
  await act(async () => {
    container.querySelectorAll('.agent-operation-feedback__label').forEach(label => label.dispatchEvent(Object.assign(new Event('animationend', { bubbles: true }), { animationName: 'agent-operation-settle' })))
  })
  const panel = document.querySelector('.agent-operation-feedback__popover')
  expect(panel, 'the original result stays available to its open reader').not.toBeNull()
  expect(panel!.textContent).toContain('created-while-reading')
  expect(useAppStore.getState().agentOperations[agentOperationKey(fork)]?.report).toBe(report)
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(document.querySelector('.agent-operation-feedback__popover')).not.toBeNull()
  visibility.mockReturnValue('visible')
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="关闭操作详情"]')!.click() })
  expect(document.querySelector('.agent-operation-feedback__popover')).toBeNull()
  expect(inline.open).toBe(true)
  expect(useAppStore.getState().agentOperations[agentOperationKey(fork)]?.report).toBe(report)
  await act(async () => { inline.querySelector('summary')!.click() })
  expect(useAppStore.getState().agentOperations[agentOperationKey(fork)]).toBeUndefined()
  expect(useAppStore.getState().sessions).toEqual([session])
})
