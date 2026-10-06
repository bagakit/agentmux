import { fixtureEpoch as _liveTailFixtureEpoch } from "../../../test/fixture-values.mjs"
const { fixtureEpoch: _reshape_fixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { ClientDeliveryDiagnostics } from '@agentmux/client-ui/delivery-diagnostics'
import type { DeliveryAttempt, DeliveryAttemptLookup } from '@agentmux/core/delivery-attempt'
import type { AgentInputSubmissionReceipt } from '@agentmux/core'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { useAppStore, type AgentSteerQueueEntry } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { messageDeliveryDiagnostics, reportMessageDeliveryDiagnostics } from '../src/renderer/src/lib/message-delivery-diagnostics'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

// The mounted first-party consumers and queue/diagnostic owners are real. Only the public
// submission/report/clipboard boundary supplies finite receipts; no Agent input is requested.
const dom = composerDOM(), sid = 'agent-1', originalOp = 't031-original-operation'
const body = 'Original message\nKeep every byte and the same execution choice.'
const condition = { expectedRun: { runId: 'run-agent-1' }, afterSubmissionId: 'original-predecessor' }
const queue = () => useAppStore.getState().agentSteerQueues[sid] ?? []
const original = () => queue().find(item => item.operationId === originalOp)!
const reporterRecords = new Map<string, DeliveryAttempt>()
let dispose: (() => void) | undefined
const releases: Array<() => void> = []

function entry(op = originalOp, overrides: Partial<AgentSteerQueueEntry> = {}): AgentSteerQueueEntry {
  return { operationId: op, runId: condition.expectedRun.runId, text: op === originalOp ? body : 'Neighbor message',
    execution: 'immediate', promptCondition: structuredClone(condition), status: 'deferred',
    awaitingExplicitSend: true, origin: 'manual', sourceChannel: 'message-tool', ...overrides }
}
function action(owner: Element, label: string): HTMLButtonElement {
  const found = [...owner.querySelectorAll<HTMLButtonElement>('button')].find(button =>
    button.getAttribute('aria-label') === label || button.textContent?.trim() === label)
  expect(found, `Actual mounted action ${label}`).toBeDefined()
  return found!
}
const card = (op = originalOp) => document.querySelector<HTMLElement>(`.composer-pending__card[data-operation-id="${op}"]`)!
const row = (op = originalOp) => dom.container.querySelector<HTMLElement>(`.composer-outbox li[data-operation-id="${op}"]`)!
async function click(button: HTMLButtonElement) { await act(async () => button.click()) }
async function settled(check: () => void) { await act(async () => { await vi.waitFor(check) }) }
async function showMailbox(op = originalOp) {
  // happy-dom lacks native Popover. Keep the actual More handler and its DOM toggle
  // consumer; this substitute supplies only the platform event, not product state.
  const panel = dom.container.querySelector<HTMLElement>('.composer-mailbox')!
  if (!panel.showPopover) Object.defineProperty(panel, 'showPopover', { configurable: true, value() {
    const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'open' }); panel.dispatchEvent(event)
  } })
  await click(action(card(op), '在 Outbox 查看待发消息和操作'))
  expect(row(op)).not.toBeNull()
  expect(row(op).querySelector('.composer-outbox__inline')).not.toBeNull()
}
function hold() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  releases.push(resolve)
  return { promise, resolve }
}
function refusal(message: string, code = 'AGENT_PROMPT_PREPARATION_FAILED') {
  return Object.assign(new Error(message), { code, detail: 'original preparation stage',
    controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 }, cause: new Error('actual inner writer unavailable') })
}
function inspectReported(logId: string): DeliveryAttemptLookup {
  const record = reporterRecords.get(logId)
  return { logId, availability: record ? 'found' : 'not-found', record: record ? structuredClone(record) : null,
    persistence: record ? 'confirmed' : null, issue: null }
}

beforeAll(async () => { dispose = await useAppStore.getState().initialize() })
afterAll(() => dispose?.())
beforeEach(() => {
  localStorage.clear(); reporterRecords.clear()
  const session = composerSession()
  session.capabilities.promptExecution = { immediate: 'interrupt-before-input' }
  useAppStore.setState({ sessions: [session], agentSteerQueues: { [sid]: [entry(), entry('neighbor')] },
    agentSteerInFlight: {}, agentSteerInFlightPhase: {}, runtimeEndpointWarnings: [], noticeReadReceipts: {},
    timelines: { [sid]: { agentSessionId: sid, revision: 0, items: [] } } })
  vi.spyOn(api.sessions, 'refresh').mockResolvedValue(session)
  vi.spyOn(api.sessions, 'inspectInput').mockResolvedValue(null)
  vi.spyOn(api.sessions, 'notifyInputOccupation').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'recordDeliveryFailure').mockImplementation(async record => {
    const previous = reporterRecords.get(record.logId)
    if (previous) expect(record).toEqual(previous)
    reporterRecords.set(record.logId, structuredClone(record))
    return inspectReported(record.logId)
  })
})

it('carries the Core waiting and stop receipts through Composer, Outbox and complete diagnostic copy without sending', async () => {
  const key = { kind: 'prompt' as const, agentSessionId: sid, expectedRun: { ...condition.expectedRun }, submissionId: originalOp }
  const ref = { key, waitGeneration: 1 }
  const inputReceipt: AgentInputSubmissionReceipt = { key, ref, persistence: 'confirmed', status: 'waiting', observation: 'rejoin-needed', admission: null,
    control: { ref, state: 'enabled', at: _reshape_fixtureEpoch(0, 0, 1), waiting: { phase: 'observer', reason: 'observer-stopped', wake: 'explicit-rejoin',
      failure: { name: 'AbortError', message: 'This operation was aborted' }, observation: { phase: 'native-peer' } } } }
  const submit = vi.spyOn(api.sessions, 'submitPrompt'), copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue()
  useAppStore.setState({ agentSteerQueues: { [sid]: [entry(originalOp, { inputReceipt })] } })
  const before = structuredClone(original()), draft = dom.draft()
  await dom.render(<AgentSessionComposer sessionId={sid} />)
  await showMailbox()
  const diagnostic = row().querySelector('.message-delivery-failure')!
  expect(diagnostic.getAttribute('data-kind')).toBe('saved-waiting')
  expect(diagnostic.querySelector('.message-delivery-failure__heading')!.textContent).toBe('已保存 · 等待确认')
  expect(diagnostic.querySelector('[role="alert"]')).toBeNull()
  await click(action(diagnostic, '复制诊断摘要'))
  expect(copy.mock.calls[0]![0]).toContain(JSON.stringify(inputReceipt.ref.key))
  expect(copy.mock.calls[0]![0]).toContain('等待代次: 1')
  expect(copy.mock.calls[0]![0]).not.toContain('\"stack\"')
  await click(action(diagnostic, '复制完整资料'))
  const exported = JSON.parse(copy.mock.calls[1]![0])
  expect(exported.inputReceipt).toEqual(inputReceipt)
  expect(exported.error).toEqual({ sourceRef: 'inputReceipt.control.waiting.failure' })
  expect(exported.error).not.toHaveProperty('inputRef')
  expect(exported.error).not.toHaveProperty('waitingObservation')
  expect(copy.mock.calls[0]![0]).toContain('This operation was aborted')
  expect(copy.mock.calls[0]![0]).not.toContain('输入结果未知')
  const inputStopReceipt = { ref, cancelOperationId: 'original-stop', outcome: 'stopped-before-dispatch' as const, at: _reshape_fixtureEpoch(0, 0, 2) }
  await act(async () => useAppStore.setState({ agentSteerQueues: { [sid]: [{ ...before, inputStopReceipt }] } }))
  expect(row().querySelector('.message-delivery-failure')!.getAttribute('data-kind')).toBe('stopped')
  await click(action(row().querySelector('.message-delivery-failure')!, '复制完整资料'))
  expect(JSON.parse(copy.mock.calls[2]![0]).inputStopReceipt).toEqual(inputStopReceipt)
  expect(original()).toEqual({ ...before, inputStopReceipt })
  expect(dom.draft()).toBe(draft)
  expect(submit).not.toHaveBeenCalled()
})
it('copies the exact original native reason through mounted Outbox, with separate compact and complete Clipboard receipts', async () => {
  const key = { kind: 'prompt' as const, agentSessionId: sid, expectedRun: { ...condition.expectedRun }, submissionId: originalOp }
  const ref = { key, waitGeneration: 7 }
  const failure = { name: 'AgentMuxError', message: 'Original native connection is unconfirmed', code: 'AGENT_NATIVE_INPUT_UNCONFIRMED',
    detail: '{"phase":"native-peer","reason":"original-connection-absent","errno":null}', stack: 'RECEIVED_NATIVE_STACK', truncated: true as const }
  const inputReceipt: AgentInputSubmissionReceipt = { key, ref, persistence: 'confirmed', status: 'waiting', observation: 'rejoin-needed', admission: null,
    control: { ref, state: 'enabled', at: _reshape_fixtureEpoch(0, 0, 1), waiting: { phase: 'native-environment', reason: 'original-environment-unconfirmed', wake: 'explicit-rejoin',
      mechanism: 'unconfirmed', observation: { phase: 'native-peer', failure } } } }
  const submit = vi.spyOn(api.sessions, 'submitPrompt'), copy = vi.spyOn(api.ui, 'writeClipboardText').mockRejectedValueOnce(new Error('OS clipboard refused')).mockResolvedValue()
  useAppStore.setState({ agentSteerQueues: { [sid]: [entry(originalOp, { inputReceipt, error: 'Old transport stopped' })] } })
  const before = structuredClone(original()), draft = dom.draft()
  await dom.render(<AgentSessionComposer sessionId={sid} />); await showMailbox()
  const diagnostic = row().querySelector('.message-delivery-failure')!
  await click(action(diagnostic, '复制诊断摘要'))
  expect(diagnostic.querySelector('[data-copy-state="failed"]')).not.toBeNull()
  await click(action(diagnostic, '复制诊断摘要'))
  const brief = copy.mock.calls[1]![0]
  for (const value of [JSON.stringify(key), '等待代次: 7', 'original-connection-absent', '"truncated":true']) expect(brief).toContain(value)
  expect(brief).not.toContain('RECEIVED_NATIVE_STACK')
  expect(diagnostic.querySelector('[data-copy-kind="summary"]')!.textContent).toBe('诊断摘要已复制')
  await click(action(diagnostic, '复制完整资料'))
  const full = JSON.parse(copy.mock.calls[2]![0])
  expect(full.inputReceipt).toEqual(inputReceipt)
  expect(full.error).toEqual({ sourceRef: 'inputReceipt.control.waiting.observation.failure' })
  expect(full.inputReceipt.control.waiting.observation.failure).toEqual(failure)
  expect(diagnostic.querySelector('[data-full-copy-state="copied"]')!.textContent).toBe('完整资料已复制')
  expect(original()).toEqual(before); expect(dom.draft()).toBe(draft); expect(submit).not.toHaveBeenCalled()
})
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await act(async () => { await useAppStore.getState().flushAgentSteerQueue(sid) })
})

it.each(['digest', 'quota', 'listener'] as const)('settles the original Desktop failure and retries card then Mailbox under %s diagnostic failure', async fault => {
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValueOnce(refusal('resource-bound original refusal')).mockResolvedValue()
  const neighbor = structuredClone(queue().find(item => item.operationId === 'neighbor'))
  const draft = 'Separate unsent editor draft'
  useAppStore.getState().setAgentComposerDraft(sid, draft)
  const nativeCrypto = globalThis.crypto
  let releaseDigest: (() => void) | undefined, unsubscribe: (() => void) | undefined
  if (fault === 'digest') {
    const digest = new Promise<ArrayBuffer>(resolve => { releaseDigest = () => resolve(new ArrayBuffer(32)) })
    vi.stubGlobal('crypto', { getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto), randomUUID: nativeCrypto.randomUUID.bind(nativeCrypto), subtle: { digest: () => digest } })
  } else if (fault === 'quota') {
    const setItem = localStorage.setItem.bind(localStorage)
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key.startsWith('agentmux.delivery-attempt.')) throw Object.assign(new Error('private diagnostic disk full'), { code: 'ENOSPC' })
      setItem(key, value)
    })
  } else unsubscribe = messageDeliveryDiagnostics.subscribe(() => { throw new Error('private diagnostic listener refusal') })
  try {
    await dom.render(<AgentSessionComposer sessionId={sid} />)
    await click(action(card(), '立即发送这条待发消息'))
    await settled(() => {
      expect(original().logId).toBeDefined()
      expect(useAppStore.getState().agentSteerInFlight[sid]).toBeUndefined()
    })
    const id = original().logId!, first = messageDeliveryDiagnostics.get(id)!.record
    expect(original()).toMatchObject(entry())
    expect(first.error).toMatchObject({ message: 'resource-bound original refusal', cause: { message: 'actual inner writer unavailable' } })
    expect(action(card(), '立即发送这条待发消息').disabled).toBe(false)
    expect(submit).toHaveBeenCalledOnce()
    await showMailbox()
    if (fault === 'quota') expect(row().textContent).toContain('ENOSPC')
    await click(action(row(), 'Send queued message immediately'))
    await settled(() => expect(queue().find(item => item.operationId === originalOp)).toBeUndefined())
    expect(submit).toHaveBeenCalledTimes(2)
    expect(submit.mock.calls[1]).toEqual(submit.mock.calls[0])
    expect(queue().find(item => item.operationId === 'neighbor')).toEqual(neighbor)
    expect(useAppStore.getState().agentComposerDrafts[sid]).toBe(draft)
    expect(messageDeliveryDiagnostics.get(id)?.record).toEqual(first)
  } finally { releaseDigest?.(); unsubscribe?.(); vi.unstubAllGlobals() }
})

it('shows failure reason once with one live diagnostic status after both Core and queue-validation refusals', async () => {
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValue(refusal('Actual preparation refusal'))
  await dom.render(<AgentSessionComposer sessionId={sid} />)
  await click(action(card(), '立即发送这条待发消息'))
  await settled(() => expect(original().logId).toBeDefined())
  const firstId = original().logId!
  await act(async () => { await reportMessageDeliveryDiagnostics() })
  await showMailbox()
  expect(original().error).toBe('Actual preparation refusal [AGENT_PROMPT_PREPARATION_FAILED]\noriginal preparation stage')
  expect(row().querySelectorAll('.delivery-log')).toHaveLength(1)
  expect(row().querySelector('.delivery-log')?.textContent?.split(firstId).length).toBe(2)
  expect(row().textContent).not.toContain('等待上传')
  expect(row().textContent).toContain('日志已保存到原 Host')
  expect(action(row(), 'Send queued message immediately').disabled).toBe(false)

  // The ordered consumer is also called outside the click wrapper. Its own failure
  // must retain the reason without baking a transient upload state into the queue.
  const { awaitingExplicitSend: _pause, ...ready } = entry(originalOp, { status: 'queued' })
  await act(async () => {
    useAppStore.setState({ agentSteerQueues: { [sid]: [ready, entry('neighbor')] } })
    await useAppStore.getState().flushAgentSteerQueue(sid, originalOp)
    await reportMessageDeliveryDiagnostics()
  })
  const drainId = original().logId!
  expect(drainId).not.toBe(firstId)
  expect(original().error).toBe('Actual preparation refusal [AGENT_PROMPT_PREPARATION_FAILED]\noriginal preparation stage')
  expect(row().querySelectorAll('.delivery-log')).toHaveLength(1)
  expect(row().querySelector('.delivery-log')?.textContent?.split(drainId).length).toBe(2)
  expect(row().textContent).not.toContain('等待上传')

  const refused = entry(originalOp, { runId: 'old-run', promptCondition: {
    expectedRun: { runId: 'old-run' }, afterSubmissionId: 'old-predecessor' } })
  await act(async () => { useAppStore.setState({ agentSteerQueues: { [sid]: [refused, entry('neighbor')] } }) })
  await click(action(row(), 'Send queued message immediately'))
  await settled(() => expect(original().logId).toBeDefined())
  const secondId = original().logId!
  expect(secondId).not.toBe(firstId)
  await act(async () => { await reportMessageDeliveryDiagnostics() })
  expect(original().error).not.toContain('logid:')
  expect(original().error).not.toContain('等待上传')
  expect(row().querySelectorAll('.delivery-log')).toHaveLength(1)
  expect(row().querySelector('.delivery-log')?.textContent?.split(secondId).length).toBe(2)
  expect(row().textContent).not.toContain('等待上传')
  expect(row().textContent).toContain('日志已保存到原 Host')
  expect(action(row(), 'Send queued message immediately').disabled).toBe(false)
  expect(submit).toHaveBeenCalledTimes(2)
  expect(messageDeliveryDiagnostics.get(firstId)?.record.error.message).toBe('Actual preparation refusal')
})

it('retries through the actual card then Mailbox with one original request, preserving both failure logs after success', async () => {
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValueOnce(refusal('first actual preparation failure'))
    .mockRejectedValueOnce(refusal('second actual preparation failure')).mockResolvedValue()
  await dom.render(<AgentSessionComposer sessionId={sid} />)
  expect(action(card(), '立即发送这条待发消息').disabled).toBe(false)
  await click(action(card(), '立即发送这条待发消息'))
  await settled(() => expect(original().logId).toBeDefined())
  const firstId = original().logId!, first = messageDeliveryDiagnostics.get(firstId)!
  expect(original()).toMatchObject(entry())
  expect(action(card(), '立即发送这条待发消息').disabled).toBe(false)
  await showMailbox()
  expect(row().textContent).toContain('first actual preparation failure')
  expect(row().textContent).toContain(firstId)
  await click(action(row(), 'Send queued message immediately'))
  await settled(() => expect(original().logId).not.toBe(firstId))
  const secondId = original().logId!, second = messageDeliveryDiagnostics.get(secondId)!
  expect(secondId).not.toBe(firstId)
  expect(second.record.error).toMatchObject({ message: 'second actual preparation failure', code: 'AGENT_PROMPT_PREPARATION_FAILED',
    detail: 'original preparation stage', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 },
    cause: { message: 'actual inner writer unavailable' } })
  expect(first.record).toMatchObject({ operationId: originalOp, expectedRunId: condition.expectedRun.runId,
    afterSubmissionId: condition.afterSubmissionId, execution: 'immediate', conditionAvailable: true })
  await act(async () => { await useAppStore.getState().flushAgentSteerQueue(sid); await reportMessageDeliveryDiagnostics() })
  expect(submit).toHaveBeenCalledTimes(2)
  expect(inspectReported(firstId).record).toEqual(first.record)
  expect(inspectReported(secondId).record).toEqual(second.record)
  expect(messageDeliveryDiagnostics.get(firstId)?.record).toEqual(first.record)
  expect(messageDeliveryDiagnostics.get(secondId)?.record).toEqual(second.record)
  expect(new ClientDeliveryDiagnostics().get(firstId)?.record).toEqual(first.record)
  expect(new ClientDeliveryDiagnostics().get(secondId)?.record).toEqual(second.record)
  await click(action(row(), 'Send queued message immediately'))
  await settled(() => expect(queue().map(item => item.operationId)).toEqual(['neighbor']))
  expect(submit).toHaveBeenCalledTimes(3)
  const calls = submit.mock.calls
  for (const call of calls) expect(call).toEqual([composerSession().control, body, originalOp, condition,
    { allowUncertainTurn: true, execution: 'immediate' }, true, undefined, 'message-tool', undefined, undefined, undefined])
  expect(inspectReported(firstId).record).toEqual(first.record)
  expect(inspectReported(secondId).record).toEqual(second.record)
  expect(messageDeliveryDiagnostics.get(firstId)?.record).toEqual(first.record)
  expect(messageDeliveryDiagnostics.get(secondId)?.record).toEqual(second.record)
  expect(dom.draft()).toBe('Keep my draft')
})

it('keeps only the actual in-flight message busy, and a second explicit choice never dispatches by a background wake', async () => {
  const first = hold(), second = hold()
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
  await dom.render(<AgentSessionComposer sessionId={sid} />)
  await click(action(card(), '立即发送这条待发消息'))
  await settled(() => expect(submit).toHaveBeenCalledTimes(1))
  expect(action(card(), '立即发送这条待发消息').disabled).toBe(true)
  expect(action(card('neighbor'), '立即发送这条待发消息').disabled).toBe(false)
  await click(action(card('neighbor'), '立即发送这条待发消息'))
  expect(submit).toHaveBeenCalledTimes(1)
  await act(async () => first.resolve())
  await settled(() => expect(submit).toHaveBeenCalledTimes(2))
  expect(submit.mock.calls.map(call => call[2])).toEqual([originalOp, 'neighbor'])
  expect(action(card('neighbor'), '立即发送这条待发消息').disabled).toBe(true)
  await act(async () => second.resolve())
  await settled(() => expect(queue()).toEqual([]))
  await act(async () => { await useAppStore.getState().flushAgentSteerQueue(sid) })
  expect(submit).toHaveBeenCalledTimes(2)
})

it.each(['card', 'mailbox'] as const)('sends a never-dispatched old-Run message through the current same Session from %s', async surface => {
  const reaction = { code: 'continue', replySource: { kind: 'captured' as const, agentSessionId: sid, recordId: 'original-record' } }
  const stale = entry(originalOp, { runId: 'old-run', promptCondition: null, enqueuedAt: _reshape_fixtureEpoch(0, 0, 100), reaction })
  const neighbor = entry('neighbor')
  const draft = 'Keep the separate current composer draft'
  useAppStore.setState({ agentSteerQueues: { [sid]: [neighbor, stale] }, agentComposerDrafts: { [sid]: draft } })
  let dispatched: AgentSteerQueueEntry | undefined
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async () => { dispatched = structuredClone(original()) })
  await dom.render(<AgentSessionComposer sessionId={sid} />)
  if (surface === 'mailbox') await showMailbox()
  expect((surface === 'card' ? card() : row()).textContent).toContain('待手动发送')
  expect((surface === 'card' ? card() : row()).textContent).not.toContain('原 Run 不可投递')
  await click(action(surface === 'card' ? card() : row(), surface === 'card' ? '立即发送这条待发消息' : 'Send queued message immediately'))
  await settled(() => expect(submit).toHaveBeenCalledOnce())
  expect(submit.mock.calls[0]!.slice(0, 4)).toEqual([
    composerSession().control, body, originalOp, { expectedRun: composerSession().control.run, afterSubmissionId: null }
  ])
  expect(dispatched).toMatchObject({ operationId: originalOp, text: body, runId: 'run-agent-1', enqueuedAt: _reshape_fixtureEpoch(0, 0, 100),
    reaction, execution: 'immediate', sourceChannel: 'message-tool' })
  expect(queue()).toEqual([neighbor])
  expect(useAppStore.getState().agentComposerDrafts[sid]).toBe(draft)
})

it('keeps an old-Run never-dispatched selection paused on background wake until the user chooses Send', async () => {
  const stale = entry(originalOp, { runId: 'old-run', promptCondition: null })
  delete stale.awaitingExplicitSend
  useAppStore.setState({ agentSteerQueues: { [sid]: [stale] } })
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue()
  await act(async () => { await useAppStore.getState().flushAgentSteerQueue(sid) })
  expect(queue()).toEqual([stale])
  expect(api.sessions.refresh).not.toHaveBeenCalled()
  expect(submit).not.toHaveBeenCalled()
})

it('retains a missing historical condition across explicit Send after a Run change', async () => {
  const stale = entry(originalOp, { runId: 'old-run' })
  delete stale.promptCondition
  useAppStore.setState({ agentSteerQueues: { [sid]: [stale] } })
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue()
  await expect(useAppStore.getState().sendQueuedAgentSteer(sid, originalOp)).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  expect(original()).toMatchObject(stale)
  expect(original().promptCondition).toBeUndefined()
  expect(submit).not.toHaveBeenCalled()
})

it('offers stale-Run Send for an unknown old operation but preserves its exact condition without dispatching to the new target', async () => {
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue()
  const stale = entry(originalOp, { runId: 'old-run', promptCondition: { expectedRun: { runId: 'old-run' }, afterSubmissionId: 'old-predecessor' } })
  useAppStore.setState({ agentSteerQueues: { [sid]: [stale] } })
  await dom.render(<AgentSessionComposer sessionId={sid} />)
  expect(action(card(), '立即发送这条待发消息').disabled).toBe(false)
  await click(action(card(), '立即发送这条待发消息'))
  await settled(() => expect(original().logId).toBeDefined())
  const logId = original().logId!
  expect(original()).toMatchObject(stale)
  expect(original().errorCode).toBe('STALE_AGENT_SESSION')
  expect(submit).not.toHaveBeenCalled()
  await showMailbox()
  expect(action(row(), 'Send queued message immediately').disabled).toBe(false)
  await click(action(row(), 'Send queued message immediately'))
  await settled(() => expect(original().logId).not.toBe(logId))
  expect(original()).toMatchObject(stale)
  expect(messageDeliveryDiagnostics.get(logId)?.record.expectedRunId).toBe('old-run')
  expect(submit).not.toHaveBeenCalled()
})

it('shows actual copy failure before success and keeps an old unknown operation unknown despite this-call CF0', async () => {
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValue(refusal('read-only preparation refused'))
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockRejectedValueOnce(new Error('clipboard refused')).mockResolvedValue()
  await dom.render(<AgentSessionComposer sessionId={sid} />)
  await click(action(card(), '立即发送这条待发消息'))
  await settled(() => expect(original().logId).toBeDefined())
  expect(original().promptCondition).toEqual(condition)
  expect(original().execution).toBe('immediate')
  await showMailbox()
  expect(row().textContent).toContain('发送结果待核实')
  expect(row().textContent).toContain('此前是否已输入仍待核实')
  const logId = original().logId!
  await click(action(row(), '复制 logid'))
  expect(action(row(), '复制失败，重试')).toBeDefined()
  expect(row().querySelector('.delivery-log')?.textContent).not.toContain('已复制 logid')
  await click(action(row(), '复制失败，重试'))
  expect(action(row(), '已复制 logid')).toBeDefined()
  expect(clipboard.mock.calls).toEqual([[logId], [logId]])
  expect(submit).toHaveBeenCalledOnce()
  expect(original().promptCondition).toEqual(condition)
})

it('records the actual final condition and execution of a freshly bound first click once, without an automatic retry', async () => {
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValueOnce(refusal('new intent first input refused'))
  const { execution: _unselected, ...fresh } = entry(originalOp, { promptCondition: null })
  useAppStore.setState({ agentSteerQueues: { [sid]: [fresh] } })
  const before = new Set(Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)))
  await dom.render(<AgentSessionComposer sessionId={sid} />)
  await click(action(card(), '立即发送这条待发消息'))
  await settled(() => expect(original().logId).toBeDefined())
  const id = original().logId!, diagnostic = messageDeliveryDiagnostics.get(id)!
  const actualCondition = { expectedRun: { runId: 'run-agent-1' }, afterSubmissionId: null }
  expect(original()).toMatchObject({ operationId: originalOp, text: body, runId: 'run-agent-1',
    promptCondition: actualCondition, execution: 'immediate', awaitingExplicitSend: true })
  expect(diagnostic.record).toMatchObject({ operationId: originalOp, conditionAvailable: true,
    expectedRunId: 'run-agent-1', afterSubmissionId: null, execution: 'immediate', stage: 'core-submit' })
  const newLogs = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    .filter(key => key?.startsWith('agentmux.delivery-attempt.') && !before.has(key))
  expect(newLogs).toEqual([`agentmux.delivery-attempt.${id}`])
  await act(async () => { await useAppStore.getState().flushAgentSteerQueue(sid) })
  expect(submit).toHaveBeenCalledOnce()
  expect(submit.mock.calls[0]![3]).toEqual(actualCondition)
  expect(action(card(), '立即发送这条待发消息').disabled).toBe(false)
})

it('preserves the draft and all original queue records when admission refuses two actual Send clicks, each with its own queryable log', async () => {
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue()
  const full = Array.from({ length: 100 }, (_, index) => entry(`capacity-original-${index}`))
  useAppStore.setState({ agentSteerQueues: { [sid]: full }, agentComposerDrafts: { [sid]: 'New intent cannot displace the original full queue' } })
  await dom.render(<AgentSessionComposer sessionId={sid} />)
  const send = action(dom.container, 'Send')
  expect(send.disabled).toBe(false)
  await click(send)
  await settled(() => expect(api.sessions.recordDeliveryFailure).toHaveBeenCalledTimes(1))
  const firstRecord = (api.sessions.recordDeliveryFailure as ReturnType<typeof vi.fn>).mock.calls[0]![0] as DeliveryAttempt
  expect(firstRecord.stage).toBe('queue-admission')
  expect(document.querySelector('.composer-feedback .message-delivery-failure pre')?.textContent).toContain(firstRecord.logId)
  expect(queue()).toEqual(full)
  expect(dom.draft()).toBe('New intent cannot displace the original full queue')
  expect(submit).not.toHaveBeenCalled()
  await click(send)
  await settled(() => expect(api.sessions.recordDeliveryFailure).toHaveBeenCalledTimes(2))
  const secondRecord = (api.sessions.recordDeliveryFailure as ReturnType<typeof vi.fn>).mock.calls[1]![0] as DeliveryAttempt
  expect(secondRecord.logId).not.toBe(firstRecord.logId)
  expect(secondRecord.stage).toBe('queue-admission')
  expect(inspectReported(firstRecord.logId).record).toEqual(firstRecord)
  expect(inspectReported(secondRecord.logId).record).toEqual(secondRecord)
  expect(queue()).toEqual(full)
  expect(action(dom.container, 'Send').disabled).toBe(false)
  expect(submit).not.toHaveBeenCalled()
})

it('keeps the captured Core control usable when a synchronous subscriber removes the presentation, retaining each failure log', async () => {
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValueOnce(refusal('restored same entry refused again'))
  const savedSession = structuredClone(useAppStore.getState().sessions[0]!)
  useAppStore.setState({ agentSteerQueues: {}, agentComposerDrafts: { [sid]: body } })
  await dom.render(<AgentSessionComposer sessionId={sid} />)
  let removed = false
  const unsubscribe = useAppStore.subscribe(state => {
    if (!removed && state.agentSteerQueues[sid]?.length) {
      removed = true
      useAppStore.setState({ sessions: [] })
    }
  })
  try {
    await click(action(dom.container, 'Send'))
    await settled(() => expect(queue()[0]?.logId).toBeDefined())
  } finally { unsubscribe() }
  const first = structuredClone(queue()[0]!), firstRecord = messageDeliveryDiagnostics.get(first.logId!)!.record
  expect(removed).toBe(true)
  expect(first.text).toBe(body)
  expect(firstRecord).toMatchObject({ operationId: first.operationId, stage: 'core-submit', error: { code: 'AGENT_PROMPT_PREPARATION_FAILED' } })
  expect(submit).toHaveBeenCalledOnce()
  await act(async () => useAppStore.setState({ sessions: [savedSession] }))
  expect(submit).toHaveBeenCalledOnce()
  await click(action(card(first.operationId), '立即发送这条待发消息'))
  await settled(() => expect(queue()[0]!.logId).not.toBe(first.logId))
  expect(queue()[0]!.operationId).toBe(first.operationId)
  expect(queue()[0]!.text).toBe(body)
  expect(submit).toHaveBeenCalledTimes(2)
  expect(submit.mock.calls[0]![2]).toBe(first.operationId)
  expect(submit.mock.calls[1]![2]).toBe(first.operationId)
  expect(messageDeliveryDiagnostics.get(first.logId!)!.record).toEqual(firstRecord)
  expect(inspectReported(first.logId!).record).toEqual(firstRecord)
})


it('keeps current-terminal manual input on the original Core key and rejoins from the mounted pending action', async () => {
 const session = composerSession()
 session.capabilities.promptExecution = {immediate: 'terminal-submit'}
 useAppStore.setState({sessions: [session], agentSteerQueues: {}, agentComposerDrafts: {[sid]: body + '\nNative steer choice'}})
 vi.mocked(api.sessions.refresh).mockResolvedValue(session)
 let receipt: AgentInputSubmissionReceipt | null = null
 const inspect = vi.spyOn(api.sessions, 'inspectInput').mockImplementation(async () => receipt)
 const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async (_control, _text, submissionId) => {
   const key = { kind: 'prompt' as const, agentSessionId: sid, expectedRun: { ...condition.expectedRun }, submissionId }, ref = { key, waitGeneration: 1 }
   return receipt = { key, ref, persistence: 'confirmed', status: 'waiting', observation: 'rejoin-needed', admission: null,
     control: { ref, state: 'enabled', at: _reshape_fixtureEpoch(0, 0, 1), waiting: { phase: 'observer', reason: 'observer-stopped', wake: 'explicit-rejoin',
       failure: { name: 'AbortError', message: 'Original observer ended' } } } }
 })
 const rejoin = vi.spyOn(api.sessions, 'rejoinInputWaiting').mockImplementation(async (_control, ref) => {
   const next = { ...ref, waitGeneration: ref.waitGeneration + 1 }
   return { ...receipt!, ref: next, observation: 'owned', control: { ref: next, state: 'enabled', at: _reshape_fixtureEpoch(0, 0, 2) } }
 })
 await dom.render(<AgentSessionComposer sessionId={sid} />)
 await click(action(dom.container, 'Send'))
 await settled(() => expect(submit).toHaveBeenCalledOnce())
 const first = structuredClone(queue()[0]!)
 expect(first.directInputBinding).toEqual({ expectedRun: condition.expectedRun, admissionIntent: { kind: 'manual-actor' } })
 expect(submit.mock.calls[0]![4]).toMatchObject({execution: 'immediate'})
 expect(submit.mock.calls[0]![3]).toEqual({ expectedRun: condition.expectedRun, admissionIntent: { kind: 'manual-actor' } })
 expect(submit.mock.calls[0]![1]).toBe(body + '\nNative steer choice')
 expect(first.inputReceipt?.key).toMatchObject({ kind: 'prompt', submissionId: first.operationId })
 await click(action(card(first.operationId), '立即发送这条待发消息'))
 await settled(() => expect(rejoin).toHaveBeenCalledOnce())
 expect(rejoin.mock.calls[0]).toEqual([session.control, first.inputReceipt!.ref])
 expect(inspect).toHaveBeenCalledTimes(2)
 expect(submit).toHaveBeenCalledOnce()
 expect(queue()[0]?.operationId).toBe(first.operationId)
 expect(queue()[0]?.inputReceipt?.ref.waitGeneration).toBe(2)
})

function terminalReceipt(submissionId: string): AgentInputSubmissionReceipt {
  const key = { kind: 'prompt' as const, agentSessionId: sid, expectedRun: { ...condition.expectedRun }, submissionId }
  const ref = { key, waitGeneration: 1 }, gateId = 'original-terminal-gate'
  return { key, ref, persistence: 'confirmed', status: 'terminal-confirmed', observation: 'closed',
    control: { ref, state: 'dispatch-authorized', gateId, at: _liveTailFixtureEpoch(0, 0, 2) },
    admission: { agentSessionId: sid, run: key.expectedRun, admission: { inputKey: key, inputDispatch: { ref, gateId },
      submissionId, operationId: 'original-terminal-phase', transport: 'pty', startByte: 0, endByte: new TextEncoder().encode(body + '\r').byteLength, acknowledged: true,
      intent: { run: key.expectedRun, ownerInstanceId: 'controlled-original-owner', prompt: body, execution: 'immediate',
        admissionIntent: { kind: 'manual-actor', expectedRun: key.expectedRun }, plan: { kind: 'single-phase', data: body + '\r' },
        message: { userContent: body, authorHuman: true } } } } }
}
function waitingReceipt(receipt: AgentInputSubmissionReceipt): AgentInputSubmissionReceipt {
  return { ...receipt, admission: null, status: 'waiting', observation: 'owned', control: { ref: receipt.ref, state: 'enabled', at: _liveTailFixtureEpoch(0, 0, 1),
    waiting: { phase: 'service', reason: 'runtime-unavailable', wake: 'runtime-restored' } } }
}

it('uses the current manual terminal without a Native catalog gate and settles its bytes before a late first-save reply', async () => {
  const session = composerSession(), reply = hold()
  useAppStore.setState({ sessions: [session], agentSteerQueues: {}, agentComposerDrafts: { [sid]: body } })
  vi.mocked(api.sessions.refresh).mockResolvedValue(session)
  vi.spyOn(api.sessions, 'inspectInput').mockResolvedValue(null)
  let receipt: AgentInputSubmissionReceipt | undefined
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async (_control, _body, op) => {
    receipt = terminalReceipt(op); await reply.promise; return waitingReceipt(receipt)
  })
  await dom.render(<AgentSessionComposer sessionId={sid} />)
  await click(action(dom.container, 'Send'))
  await settled(() => expect(submit).toHaveBeenCalledOnce())
  const op = queue()[0]!.operationId
  expect(submit.mock.calls[0]![3]).toEqual({ expectedRun: condition.expectedRun, admissionIntent: { kind: 'manual-actor' } })
  const publish = (value: AgentInputSubmissionReceipt) => useAppStore.getState().applyEvent({ hostId: 'local', event: { type: 'agent-input', receipt: value } })
  await act(async () => publish(receipt!))
  expect(queue()[0]).toMatchObject({ operationId: op, archived: true, inputReceipt: receipt })
  await act(async () => useAppStore.getState().setAgentComposerDraft(sid, 'Independent neighbor draft'))
  expect(action(dom.container, 'Send').disabled).toBe(false)
  const panel = dom.container.querySelector<HTMLElement>('.composer-mailbox')!
  await act(async () => {
    const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'open' }); panel.dispatchEvent(event)
  })
  await click(action(dom.container, 'Outbox'))
  expect(row(op).textContent).toContain('终端输入已确认')
  await click(row(op).querySelector<HTMLButtonElement>('.composer-mailbox__row')!)
  expect(row(op).textContent).toContain('Native 是否采用尚未确认')
  expect(row(op).textContent).toContain('不是任务完成')
  expect(row(op).querySelectorAll('.composer-pending__retry')).toHaveLength(1)
  expect(row(op).querySelector('.composer-mailbox__record-note')).toBeNull()
  expect([...row(op).querySelectorAll('button')].some(button => button.getAttribute('aria-label') === 'Send queued message immediately')).toBe(false)
  await act(async () => reply.resolve())
  expect(queue()[0]!.inputReceipt).toEqual(receipt)
  expect(useAppStore.getState().agentSteerInFlight[sid]).toBeUndefined()
  await act(async () => publish({ ...receipt!, status: 'unknown', observation: 'rejoin-needed' }))
  expect(queue()[0]!.inputReceipt).toEqual(receipt)
  const conflict = structuredClone(receipt!)
  conflict.admission!.admission!.endByte++
  await act(async () => publish(conflict))
  expect(queue()[0]!.inputReceipt).toEqual(receipt)
  expect(useAppStore.getState().error).toContain('conflict')
  expect(submit).toHaveBeenCalledOnce()
})

it('keeps queue-only Enter unbound and freezes a current-terminal manual intent only on its explicit Send', async () => {
  const session = composerSession(); session.status = { state: 'working', source: 'native-hook', observedAt: _liveTailFixtureEpoch(0, 0, 1) }
  useAppStore.setState({ sessions: [session], agentSteerQueues: {} })
  vi.mocked(api.sessions.refresh).mockResolvedValue(session)
  vi.spyOn(api.sessions, 'inspectInput').mockResolvedValue(null)
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async (_control, _body, op) => terminalReceipt(op))
  expect(useAppStore.getState().enqueueAgentSteer(sid, body, undefined, undefined, 'manual')).toBe(true)
  const op = queue()[0]!.operationId
  expect(queue()[0]).not.toHaveProperty('directInputBinding')
  await act(async () => { await useAppStore.getState().flushAgentSteerQueue(sid) })
  expect(submit).not.toHaveBeenCalled()
  await dom.render(<AgentSessionComposer sessionId={sid} />)
  await act(async () => { await useAppStore.getState().sendQueuedAgentSteer(sid, op) })
  await settled(() => expect(submit).toHaveBeenCalledOnce())
  expect(submit.mock.calls[0]![3]).toEqual({ expectedRun: session.control.run, admissionIntent: { kind: 'manual-actor' } })
  expect(queue()[0]).toMatchObject({ archived: true, inputReceipt: { status: 'terminal-confirmed' } })
})


it.each(['missing','wrong-session','wrong-run'] as const)('refuses a %s captured control without falling through to the current route', async invalid => {
  const session=composerSession(),binding={expectedRun:session.control.run,admissionIntent:{kind:'manual-actor' as const}}
  const control={...session.control,...(invalid==='wrong-session'?{agentSessionId:'another-session'}:{}),...(invalid==='wrong-run'?{run:{runId:'another-run'}}:{})}
  useAppStore.setState({sessions:[session],agentSteerQueues:{[sid]:[entry(originalOp,{promptCondition:null,directInputBinding:binding,...(invalid==='missing'?{}:{directInputControl:control})})]}})
  const inspect=vi.spyOn(api.sessions,'inspectInput').mockResolvedValue(null),submit=vi.spyOn(api.sessions,'submitPrompt')
  await expect(useAppStore.getState().sendQueuedAgentSteer(sid,originalOp)).rejects.toMatchObject({code:'CONTROL_REQUEST_CONFLICT'})
  expect(inspect).not.toHaveBeenCalled();expect(submit).not.toHaveBeenCalled()
  expect(original().directInputBinding).toEqual(binding)
})

it('inspects the exact captured old control when the current Session Run has changed', async () => {
 const old=composerSession(),current={...old,control:{...old.control,run:{runId:'replacement-run'}}}
 const receipt=terminalReceipt(originalOp)
 useAppStore.setState({sessions:[current],agentSteerQueues:{[sid]:[entry(originalOp,{promptCondition:null,directInputBinding:{expectedRun:old.control.run,admissionIntent:{kind:'manual-actor'}},directInputControl:old.control})]}})
 const inspect=vi.spyOn(api.sessions,'inspectInput').mockResolvedValue(receipt),submit=vi.spyOn(api.sessions,'submitPrompt')
 const observed=await useAppStore.getState().sendQueuedAgentSteer(sid,originalOp).then(result=>({result}),error=>({error}))
 expect(observed).toMatchObject({result:'submitted'})
 expect(inspect).toHaveBeenCalledExactlyOnceWith(old.control,receipt.key)
 expect(submit).not.toHaveBeenCalled();expect(original().inputReceipt).toEqual(receipt)
})

it('retains a confirmed original gate when a contradictory higher generation arrives', async () => {
 const session=composerSession(),receipt=terminalReceipt(originalOp)
 useAppStore.setState({sessions:[session],agentSteerQueues:{[sid]:[entry(originalOp,{promptCondition:null,archived:true,directInputBinding:{expectedRun:session.control.run,admissionIntent:{kind:'manual-actor'}},directInputControl:session.control,inputReceipt:receipt})]}})
 const late=waitingReceipt(receipt),ref={...late.ref,waitGeneration:2}
 await act(async()=>useAppStore.getState().applyEvent({hostId:'local',event:{type:'agent-input',receipt:{...late,ref,control:{...late.control,ref}}}}))
 expect(original().inputReceipt).toEqual(receipt)
 expect(useAppStore.getState().error).toContain('later waiting generation conflicts')
})


it('does not use a controlled input timeline row to confirm location or prevent restoring its original archive', async () => {
 const session=composerSession(),binding={expectedRun:session.control.run,admissionIntent:{kind:'manual-actor' as const}}
 useAppStore.setState({sessions:[session],agentSteerQueues:{[sid]:[entry(originalOp,{promptCondition:null,directInputBinding:binding,directInputControl:session.control,archived:true,inputIntakeStarted:true})]},timelines:{[sid]:{agentSessionId:sid,revision:1,items:[{id:'prompt:'+originalOp,agentSessionId:sid,kind:'user_message',status:'complete',source:'agentmux',createdAt:_liveTailFixtureEpoch(0, 0, 1),updatedAt:_liveTailFixtureEpoch(0, 0, 1),title:'Authored input',content:body}]}}})
 await dom.render(<AgentSessionComposer sessionId={sid} />)
 const panel=dom.container.querySelector<HTMLElement>('.composer-mailbox')!
 await act(async()=>{const event=new Event('toggle');Object.defineProperty(event,'newState',{value:'open'});panel.dispatchEvent(event)})
 await click(action(dom.container,'Outbox'))
 await click(row().querySelector<HTMLButtonElement>('.composer-mailbox__row')!)
 expect(row().textContent).not.toContain('输入已确认')
 expect(row().querySelector<HTMLButtonElement>('[aria-label="恢复为待发"]')!.disabled).toBe(false)
 const submit=vi.spyOn(api.sessions,'submitPrompt')
 const restored=await useAppStore.getState().archiveAgentSteer(sid,originalOp,body,false).then(result=>({result}),error=>({error}))
 expect(restored).toMatchObject({result:{changed:true,entry:{operationId:originalOp}}})
 expect(original().archived).not.toBe(true)
 expect(original().directInputBinding).toEqual(binding)
 await act(async()=>{})
 expect(row()).not.toBeNull()
 expect(row().textContent).not.toContain('输入已确认')
 expect(submit).not.toHaveBeenCalled()
})
