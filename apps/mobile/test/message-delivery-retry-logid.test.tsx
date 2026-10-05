import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DeliveryAttempt, DeliveryAttemptLookup } from '@agentmux/core/delivery-attempt'
import { ClientDeliveryDiagnostics } from '@agentmux/client-ui/delivery-diagnostics'
import { MobileConversationSurface, type MobileConversationSurfaceProps } from '../src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../src/platform/browser'
import { DeviceWorkfaceStore, emptyDeviceWorkface, getDeviceWorkface, parseDraftRecord } from '../src/recovery/device-workface'
import { button, click, deferred, editor, evidence, fixture, mount, mounted, paste, session } from './conversation-fixture'

const connected = { state: 'connected' as const, message: '已连接原 Host' }
const draftKey = JSON.stringify(['draft', 'session-original'])
const body = 'Original mobile message\nKeep the original operation, condition and execution.'
const remoteRecords = new Map<string, DeliveryAttempt>()
function refusal(message: string, code = 'AGENT_PROMPT_PREPARATION_FAILED') {
  return Object.assign(new Error(message), { code, detail: 'original source preparation stage',
    controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 }, cause: new Error('original image witness unavailable') })
}
function storedAttempt() {
  return getDeviceWorkface().snapshot().record.conversation.attempts.find(([key]) => key === draftKey)![1]
}
function log(logId: string) { return new ClientDeliveryDiagnostics().get(logId)! }
function inspect(logId: string): DeliveryAttemptLookup {
  const record = remoteRecords.get(logId)
  return { logId, availability: record ? 'found' : 'not-found', record: record ? structuredClone(record) : null,
    persistence: record ? 'confirmed' : null, issue: null }
}
function consumer() {
  const f = fixture(), clipboard = vi.fn().mockResolvedValue(undefined)
  let runtimeId = 'original-runtime'
  const report = vi.fn(async (method: string, params: { hostId: string; record: DeliveryAttempt }) => {
    expect(method).toBe('message.delivery.report')
    expect(params.hostId).toBe('local')
    const previous = remoteRecords.get(params.record.logId)
    if (previous) expect(params.record).toEqual(previous)
    remoteRecords.set(params.record.logId, structuredClone(params.record))
    return inspect(params.record.logId)
  })
  Object.assign(f.client, { runtimeOwnerIdentity: () => ({ runtimeId }), forwardRpc: report })
  const options: MobileConversationSurfaceProps = { client: f.client, agentSessionId: 'session-original', connection: connected,
    platform: createBrowserPlatform({ clipboard: { writeText: clipboard } }) }
  return { ...f, options, clipboard, report, replaceRuntime: (value: string) => { runtimeId = value } }
}
async function settled(check: () => void) { await act(async () => { await vi.waitFor(check) }) }
beforeEach(async () => { localStorage.clear(); remoteRecords.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it.each(['digest', 'quota', 'listener'] as const)('releases the fresh Mobile sending phase and retries the exact original request under %s diagnostic failure', async fault => {
  const f = consumer(); f.submit.mockRejectedValueOnce(refusal('resource-bound original mobile refusal')).mockResolvedValue(undefined)
  let actualJournal: ClientDeliveryDiagnostics | undefined
  const failed = ClientDeliveryDiagnostics.prototype.failed
  vi.spyOn(ClientDeliveryDiagnostics.prototype, 'failed').mockImplementation(function (this: ClientDeliveryDiagnostics, ...args) {
    actualJournal = this
    return failed.apply(this, args)
  })
  const nativeCrypto = globalThis.crypto
  let releaseDigest: (() => void) | undefined
  if (fault === 'digest') {
    const digest = new Promise<ArrayBuffer>(resolve => { releaseDigest = () => resolve(new ArrayBuffer(32)) })
    vi.stubGlobal('crypto', { getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto), randomUUID: nativeCrypto.randomUUID.bind(nativeCrypto), subtle: { digest: () => digest } })
  } else if (fault === 'quota') {
    const setItem = localStorage.setItem.bind(localStorage)
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key.startsWith('agentmux.delivery-attempt.')) throw Object.assign(new Error('private diagnostic storage denied'), { code: 'EACCES' })
      setItem(key, value)
    })
  } else {
    const subscribe = ClientDeliveryDiagnostics.prototype.subscribe
    vi.spyOn(ClientDeliveryDiagnostics.prototype, 'subscribe').mockImplementation(function (this: ClientDeliveryDiagnostics, listener) {
      const removeFailure = subscribe.call(this, () => { throw new Error('private mounted diagnostic listener refusal') })
      const removeConsumer = subscribe.call(this, listener)
      return () => { removeFailure(); removeConsumer() }
    })
  }
  try {
    const view = await mount(<MobileConversationSurface {...f.options} />)
    await paste(view.element, body); await click(button(view.element, 'Send'))
    await settled(() => {
      expect(storedAttempt().logId).toBeDefined()
      expect(storedAttempt().phase).toBe('rejected')
    })
    const first = structuredClone(storedAttempt()), firstRecord = actualJournal!.get(first.logId!)!.record
    expect(firstRecord.error).toMatchObject({ message: 'resource-bound original mobile refusal', cause: { message: 'original image witness unavailable' } })
    expect(button(view.element, 'Send').disabled).toBe(false)
    expect(button(view.element, '重试原请求')).toBeDefined()
    if (fault === 'quota') expect(view.element.textContent).toContain('EACCES')
    expect(f.submit).toHaveBeenCalledOnce()
    await click(button(view.element, '重试原请求'))
    await settled(() => expect(storedAttempt().phase).toBe('confirmed'))
    expect(f.submit).toHaveBeenCalledTimes(2)
    expect(f.submit.mock.calls[1]).toEqual(f.submit.mock.calls[0])
    expect(storedAttempt()).toMatchObject({ operationId: first.operationId, runId: first.runId, request: first.request })
    expect(actualJournal!.get(first.logId!)!.record).toEqual(firstRecord)
  } finally { releaseDigest?.() }
})

it.each(['preparation', 'lost-ack'] as const)('continues the same %s request through two explicit failures and one success, retaining two old queryable logs', async kind => {
  const f = consumer()
  const firstError = kind === 'preparation' ? refusal('first precise preparation refusal')
    : Object.assign(new Error('first ACK disappeared after possible input'), { code: 'TRANSPORT_LOST',
      controlFailure: { disposition: 'unknown', confirmedInputBytes: 9 }, cause: new Error('actual reply channel closed') })
  f.submit.mockRejectedValueOnce(firstError).mockRejectedValueOnce(refusal('second actual call refused')).mockResolvedValue(undefined)
  const view = await mount(<MobileConversationSurface {...f.options} />)
  await paste(view.element, body)
  await click(button(view.element, 'Send'))
  await settled(() => expect(storedAttempt().logId).toBeDefined())
  const firstAttempt = structuredClone(storedAttempt()), firstId = firstAttempt.logId!, firstRecord = log(firstId).record
  expect(firstAttempt.phase).toBe(kind === 'preparation' ? 'rejected' : 'unknown')
  expect(firstAttempt.request).toBeDefined()
  expect(view.element.textContent).toContain(firstError.message)
  expect(view.element.textContent).toContain(firstId)
  const diagnosis = view.element.querySelector<HTMLDetailsElement>('.mobile-send-status__diagnosis')!
  expect(diagnosis.open).toBe(false)
  expect(diagnosis.querySelector('summary')?.textContent).toBe('发送详情')
  expect(diagnosis.textContent).toContain(firstAttempt.operationId)
  expect(diagnosis.textContent).toContain(firstAttempt.runId)
  expect(diagnosis.textContent).toContain(firstError.message)
  expect(diagnosis.textContent).toContain(firstId)
  const summary = view.element.querySelector('.mobile-send-status__summary')!
  expect(summary.textContent).not.toContain(firstError.message)
  expect(summary.textContent).toContain('草稿已保留')
  expect(button(view.element, '重试原请求').closest('details')).toBeNull()
  expect(button(view.element, 'Send').disabled).toBe(false)
  await click(button(view.element, '重试原请求'))
  await settled(() => expect(storedAttempt().logId).not.toBe(firstId))
  const secondAttempt = structuredClone(storedAttempt()), secondId = secondAttempt.logId!, secondRecord = log(secondId).record
  expect(secondId).not.toBe(firstId)
  expect(secondAttempt).toMatchObject({ operationId: firstAttempt.operationId, runId: firstAttempt.runId,
    request: firstAttempt.request, draft: body, inputRequested: true, phase: firstAttempt.phase })
  expect(secondRecord.error).toMatchObject({ message: 'second actual call refused', detail: 'original source preparation stage',
    code: 'AGENT_PROMPT_PREPARATION_FAILED', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 },
    cause: { message: 'original image witness unavailable' } })
  if (kind === 'lost-ack') expect(log(firstId).record.error.controlFailure).toEqual({ disposition: 'unknown', confirmedInputBytes: 9 })
  await click(button(view.element, '刷新'))
  await act(async () => { f.emit({ type: 'connection-state', state: 'lost', evidence }); f.emit({ type: 'connection-state', state: 'restored', evidence }) })
  expect(f.submit).toHaveBeenCalledTimes(2)
  await settled(() => expect(inspect(firstId).availability).toBe('found'))
  expect(inspect(firstId).record).toEqual(firstRecord)
  expect(inspect(secondId).record).toEqual(secondRecord)
  await click(button(view.element, 'Send'))
  await settled(() => expect(storedAttempt().phase).toBe('confirmed'))
  expect(f.submit).toHaveBeenCalledTimes(3)
  const request = f.submit.mock.calls[0]![0]
  expect(request).toMatchObject({ agentSessionId: 'session-original', operationId: firstAttempt.operationId,
    expectedRun: { runId: 'run-original' }, afterSubmissionId: null, prompt: body, authorHuman: true, allowUncertainTurn: true })
  expect(f.submit.mock.calls.map(call => call[0])).toEqual([request, request, request])
  expect(storedAttempt().operationId).toBe(firstAttempt.operationId)
  expect(editor(view.element).textContent).toBe('')
  expect(log(firstId).record).toEqual(firstRecord)
  expect(log(secondId).record).toEqual(secondRecord)
  expect(inspect(firstId).record).toEqual(firstRecord)
  expect(inspect(secondId).record).toEqual(secondRecord)
})

it('copies the exact logid only after the actual clipboard callback confirms success', async () => {
  const f = consumer(); f.submit.mockRejectedValueOnce(refusal('copyable original failure'))
  f.clipboard.mockRejectedValueOnce(new Error('real clipboard permission refused')).mockResolvedValue(undefined)
  const view = await mount(<MobileConversationSurface {...f.options} />)
  await paste(view.element, body); await click(button(view.element, 'Send'))
  await settled(() => expect(storedAttempt().logId).toBeDefined())
  const logId = storedAttempt().logId!
  await click(button(view.element, '复制 logid'))
  expect(button(view.element, '复制失败，重试')).toBeDefined()
  expect(view.element.querySelector('.delivery-log')?.textContent).not.toContain('已复制 logid')
  await click(button(view.element, '复制失败，重试'))
  expect(button(view.element, '已复制 logid')).toBeDefined()
  expect(f.clipboard.mock.calls).toEqual([[logId], [logId]])
  expect(f.submit).toHaveBeenCalledOnce()
  expect([...editor(view.element).querySelectorAll('p')].map(node => node.textContent)).toEqual(body.split('\n'))
})

it.each(['run', 'runtime'] as const)('keeps every retry visible but refuses a changed %s without reassigning the original request', async target => {
  const f = consumer(); f.submit.mockRejectedValueOnce(refusal('retain original target'))
  const view = await mount(<MobileConversationSurface {...f.options} />)
  await paste(view.element, body); await click(button(view.element, 'Send'))
  await settled(() => expect(storedAttempt().logId).toBeDefined())
  const original = structuredClone(storedAttempt())
  if (target === 'run') { const changed = session(); changed.run = { runId: 'other-current-run' }; f.sessions.set('session-original', changed) }
  else f.replaceRuntime('another-runtime')
  await click(button(view.element, '重试原请求'))
  await settled(() => expect(storedAttempt().logId).not.toBe(original.logId))
  const later = structuredClone(storedAttempt()), laterRecord = log(later.logId!).record
  expect(later).toMatchObject({ operationId: original.operationId, runId: original.runId, request: original.request, draft: body })
  expect(laterRecord.stage).toBe('retry-validation')
  expect(laterRecord.error.code).toBe(target === 'run' ? 'AGENT_PROMPT_INPUT_UNCONFIRMED' : 'STALE_AGENT_SESSION')
  expect(f.submit).toHaveBeenCalledOnce()
  expect(button(view.element, '重试原请求')).toBeDefined()
  expect([...editor(view.element).querySelectorAll('p')].map(node => node.textContent)).toEqual(body.split('\n'))
  expect(log(original.logId!).record.operationId).toBe(original.operationId)
})

it('has one actual in-flight request, keeps a distinct edited draft, and never automatically replays after navigation', async () => {
  const f = consumer(), pending = deferred<void>()
  f.submit.mockRejectedValueOnce(refusal('original first failure')).mockImplementationOnce(() => pending.promise)
  const view = await mount(<MobileConversationSurface {...f.options} />)
  await paste(view.element, body); await click(button(view.element, 'Send'))
  await settled(() => expect(storedAttempt().logId).toBeDefined())
  const original = structuredClone(storedAttempt()), retry = button(view.element, '重试原请求')
  await act(async () => { retry.click(); retry.click() })
  expect(f.submit).toHaveBeenCalledTimes(2)
  expect(storedAttempt().phase).toBe('sending')
  expect(button(view.element, 'Send').disabled).toBe(true)
  await view.render(<MobileConversationSurface {...f.options} agentSessionId="other" />)
  await paste(view.element, 'Distinct neighboring draft')
  expect(button(view.element, 'Send').disabled).toBe(false)
  await act(async () => pending.resolve())
  expect(editor(view.element).textContent).toBe('Distinct neighboring draft')
  expect(storedAttempt().phase).toBe('confirmed')
  await view.render(<MobileConversationSurface {...f.options} />)
  expect(editor(view.element).textContent).toBe('')
  expect(f.submit).toHaveBeenCalledTimes(2)
  expect(f.submit.mock.calls[1]![0]).toEqual(f.submit.mock.calls[0]![0])
  expect(log(original.logId!).record.operationId).toBe(original.operationId)
})

it.each(['known', 'unknown'] as const)('retains offline failure with %s diagnostic owner until an explicit retry', async owner => {
  const f = consumer(), offline = { state: 'disconnected' as const, message: 'Original Host connection lost' }
  if (owner === 'unknown') Object.assign(f.client, { runtimeOwnerIdentity: undefined })
  const view = await mount(<MobileConversationSurface {...f.options} connection={offline} />)
  await paste(view.element, body); await click(button(view.element, 'Send'))
  await settled(() => expect(storedAttempt().logId).toBeDefined())
  const original = structuredClone(storedAttempt()), record = log(original.logId!).record
  expect(record.stage).toBe('client-validation')
  expect(record.conditionAvailable).toBe(false)
  expect(original.inputRequested).toBe(false)
  expect(original.explicit).toBe(true)
  if (owner === 'unknown') {
    expect(view.element.textContent).toContain('原诊断 Host 未核实，暂不能远端查询')
    expect(log(original.logId!).owner).toBeNull()
    expect(f.report).not.toHaveBeenCalled()
  }
  expect(f.submit).not.toHaveBeenCalled()
  expect(button(view.element, 'Send').disabled).toBe(false)
  await view.render(<MobileConversationSurface {...f.options} />)
  expect(f.submit).not.toHaveBeenCalled()
  expect(log(original.logId!).record).toEqual(record)
  await click(button(view.element, '重试原请求'))
  await settled(() => expect(storedAttempt().phase).toBe('confirmed'))
  expect(f.submit).toHaveBeenCalledOnce()
  expect(f.submit.mock.calls[0]![0].operationId).toBe(original.operationId)
  expect(f.submit.mock.calls[0]![0].prompt).toBe(body)
  expect(log(original.logId!).record).toEqual(record)
})

it('reopens the actual device record with the original request/runtime/inputRequested facts and no automatic retry', async () => {
  const f = consumer(); f.submit.mockRejectedValueOnce(refusal('durable original failed request'))
  const view = await mount(<MobileConversationSurface {...f.options} />)
  await paste(view.element, body); await click(button(view.element, 'Send'))
  await settled(() => expect(storedAttempt().logId).toBeDefined())
  const saved = structuredClone(storedAttempt()), originalBytes = localStorage.getItem('agentmux-mobile-workface-v1')
  expect(saved).toMatchObject({ explicit: true, inputRequested: true, originalRuntimeId: 'original-runtime',
    request: { runtimeId: 'original-runtime', condition: { expectedRun: { runId: 'run-original' }, afterSubmissionId: null }, explicit: true } })
  const first = mounted.pop()!
  await act(async () => first.root.unmount()); first.element.remove()
  const reopened = new DeviceWorkfaceStore(() => localStorage).snapshot()
  expect(reopened.issue).toBeNull()
  expect(reopened.record.conversation.attempts.find(([key]) => key === draftKey)?.[1]).toEqual(saved)
  const restored = await mount(<MobileConversationSurface {...f.options} />)
  expect(f.submit).toHaveBeenCalledOnce()
  expect(storedAttempt()).toEqual(saved)
  expect(localStorage.getItem('agentmux-mobile-workface-v1')).toBe(originalBytes)
  expect(button(restored.element, '重试原请求')).toBeDefined()
  const malformed = structuredClone(reopened.record.conversation)
  Object.assign(malformed.attempts[0]![1], { inputRequested: 'true' })
  expect(() => parseDraftRecord(malformed)).toThrow()
  const malformedChoice = structuredClone(reopened.record.conversation)
  Object.assign(malformedChoice.attempts[0]![1], { explicit: 'false' })
  expect(() => parseDraftRecord(malformedChoice)).toThrow()
})

it('keeps a legacy unknown retry reachable but never fabricates its missing original condition', async () => {
  getDeviceWorkface().updateConversation({ version: 1, drafts: [[draftKey, body]], responses: [],
    attempts: [[draftKey, { operationId: 'legacy-original-operation', runId: 'run-original', draft: body, phase: 'unknown' }]] })
  const f = consumer(), view = await mount(<MobileConversationSurface {...f.options} />)
  expect(button(view.element, '重试原请求')).toBeDefined()
  await click(button(view.element, '重试原请求'))
  await settled(() => expect(storedAttempt().logId).toBeDefined())
  expect(f.submit).not.toHaveBeenCalled()
  expect(storedAttempt()).toMatchObject({ operationId: 'legacy-original-operation', runId: 'run-original', draft: body, phase: 'unknown' })
  expect(storedAttempt()).not.toHaveProperty('request')
  expect(storedAttempt()).not.toHaveProperty('inputRequested')
  expect(log(storedAttempt().logId!).record).toMatchObject({ operationId: 'legacy-original-operation',
    conditionAvailable: false, error: { code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' } })
  expect(button(view.element, '重试原请求')).toBeDefined()
})


it('refuses distinct draft Send in the same Session and only an explicit original-request action retries the unknown input', async () => {
  const f = consumer()
  f.submit.mockRejectedValueOnce(Object.assign(new Error('original ACK unavailable'), { code: 'TRANSPORT_LOST',
    controlFailure: { disposition: 'unknown', confirmedInputBytes: 9 } })).mockResolvedValue(undefined)
  const view = await mount(<MobileConversationSurface {...f.options} />)
  await paste(view.element, body); await click(button(view.element, 'Send'))
  await settled(() => expect(storedAttempt().phase).toBe('unknown'))
  const original = structuredClone(storedAttempt()), firstRecord = log(original.logId!).record
  await act(async () => {
    const node = editor(view.element); node.focus()
    const range = document.createRange(); range.selectNodeContents(node)
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
  })
  await paste(view.element, 'Distinct current Session draft')
  expect(editor(view.element).textContent).toBe('Distinct current Session draft')
  await click(button(view.element, 'Send'))
  await settled(() => expect(storedAttempt().logId).not.toBe(original.logId))
  expect(f.submit).toHaveBeenCalledOnce()
  expect(storedAttempt()).toMatchObject({ operationId: original.operationId, draft: original.draft,
    request: original.request, runId: original.runId, phase: 'unknown' })
  expect(log(storedAttempt().logId!).record).toMatchObject({ operationId: null, stage: 'editor-validation',
    error: { code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' } })
  expect(view.element.textContent).toContain('当前正文已不同。本次未发送')
  expect(editor(view.element).textContent).toBe('Distinct current Session draft')
  expect(log(original.logId!).record).toEqual(firstRecord)
  await click(button(view.element, '重试原请求'))
  await settled(() => expect(storedAttempt().phase).toBe('confirmed'))
  expect(f.submit.mock.calls.map(call => call[0])).toEqual([f.submit.mock.calls[0]![0], f.submit.mock.calls[0]![0]])
  expect(editor(view.element).textContent).toBe('Distinct current Session draft')
})

it('reopens an offline plain Enter intent and binds its first condition without upgrading the original execution choice', async () => {
  const f = consumer(), offline = { state: 'disconnected' as const, message: 'Original Host connection lost' }
  const view = await mount(<MobileConversationSurface {...f.options} connection={offline} />)
  await paste(view.element, body)
  await act(async () => editor(view.element).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  await settled(() => expect(storedAttempt().logId).toBeDefined())
  const original = structuredClone(storedAttempt())
  expect(original).toMatchObject({ explicit: false, inputRequested: false, draft: body, phase: 'rejected' })
  expect(original).not.toHaveProperty('request')
  expect(f.submit).not.toHaveBeenCalled()
  const first = mounted.pop()!
  await act(async () => first.root.unmount()); first.element.remove()
  expect(new DeviceWorkfaceStore(() => localStorage).snapshot().record.conversation.attempts.find(([key]) => key === draftKey)?.[1]).toEqual(original)
  const restored = await mount(<MobileConversationSurface {...f.options} />)
  expect(f.submit).not.toHaveBeenCalled()
  await click(button(restored.element, '重试原请求'))
  await settled(() => expect(storedAttempt().phase).toBe('confirmed'))
  expect(f.submit).toHaveBeenCalledOnce()
  const request = f.submit.mock.calls[0]![0]
  expect(request).toMatchObject({ operationId: original.operationId, prompt: body, expectedRun: { runId: 'run-original' }, afterSubmissionId: null })
  expect(request).not.toHaveProperty('allowUncertainTurn')
  expect(request.execution).toBe('default')
  expect(storedAttempt().request).toMatchObject({ execution: 'default', explicit: false })
  expect(log(original.logId!).record.operationId).toBe(original.operationId)
})

it.each(['default', 'immediate'] as const)('binds a proven never-requested %s intent to the current Run only after a new explicit Send in the original Runtime/Host/Session', async execution => {
  const f = consumer(), view = await mount(<MobileConversationSurface {...f.options} />)
  await paste(view.element, body)
  await view.render(<MobileConversationSurface {...f.options} connection={{ state: 'disconnected', message: 'original connection lost before input' }} />)
  if (execution === 'default') await act(async () => editor(view.element).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  else await click(button(view.element, 'Send'))
  await settled(() => expect(storedAttempt().inputRequested).toBe(false))
  const original = structuredClone(storedAttempt())
  expect(original).toMatchObject({ runId: 'run-original', originalHostId: 'host-original', originalRuntimeId: 'original-runtime' })
  expect(original.request).toBeUndefined(); expect(f.submit).not.toHaveBeenCalled()
  const current = session(); current.run = { runId: 'replacement-original-run' }
  f.sessions.set(current.agentSessionId, current)
  await view.render(<MobileConversationSurface {...f.options} />)
  await act(async () => f.emit({ type: 'agent-session', session: current }))
  expect(f.submit).not.toHaveBeenCalled()
  expect(storedAttempt()).toEqual(original)
  await click(button(view.element, 'Send'))
  await settled(() => expect(storedAttempt().phase).toBe('confirmed'))
  expect(f.submit).toHaveBeenCalledExactlyOnceWith({ agentSessionId: current.agentSessionId, operationId: original.operationId,
    prompt: body, authorHuman: true, expectedRun: current.run, afterSubmissionId: null, execution,
    ...(execution === 'immediate' ? { allowUncertainTurn: true } : {}) })
  expect(storedAttempt().request).toMatchObject({ condition: { expectedRun: current.run }, execution, explicit: execution === 'immediate' })
})

it.each(['host', 'missing-host', 'runtime'] as const)('refuses never-requested Run rebinding when original %s cannot be confirmed', async reason => {
  const key = JSON.stringify(['draft', 'session-original'])
  getDeviceWorkface().updateConversation({ version: 1, drafts: [[key, body]], responses: [], attempts: [[key, {
    operationId: 'original-never-requested', runId: 'run-original', draft: body, phase: 'rejected', inputRequested: false,
    originalRuntimeId: 'original-runtime', ...(reason === 'missing-host' ? {} : { originalHostId: 'host-original' }), explicit: true
  }]] })
  const f = consumer(), current = session(); current.run = { runId: 'replacement-run' }
  if (reason === 'host') current.hostId = 'another-host'
  if (reason === 'runtime') f.replaceRuntime('another-runtime')
  f.sessions.set(current.agentSessionId, current)
  const view = await mount(<MobileConversationSurface {...f.options} />)
  await click(button(view.element, 'Send'))
  await settled(() => expect(storedAttempt().logId).toBeDefined())
  expect(f.submit).not.toHaveBeenCalled()
  expect(storedAttempt()).toMatchObject({ operationId: 'original-never-requested', runId: 'run-original', draft: body, inputRequested: false })
  expect(storedAttempt().request).toBeUndefined()
})


it('refuses a never-dispatched legacy intent whose original explicit choice is unknown', async () => {
  getDeviceWorkface().updateConversation({ version: 1, drafts: [[draftKey, body]], responses: [],
    attempts: [[draftKey, { operationId: 'legacy-unrequested-operation', runId: 'run-original', draft: body,
      phase: 'rejected', inputRequested: false, originalRuntimeId: 'original-runtime' }]] })
  const f = consumer(), view = await mount(<MobileConversationSurface {...f.options} />)
  await click(button(view.element, '重试原请求'))
  await settled(() => expect(storedAttempt().logId).toBeDefined())
  expect(f.submit).not.toHaveBeenCalled()
  expect(storedAttempt()).not.toHaveProperty('request')
  expect(storedAttempt()).not.toHaveProperty('explicit')
  expect(log(storedAttempt().logId!).record).toMatchObject({ operationId: 'legacy-unrequested-operation',
    stage: 'retry-validation', error: { code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' } })
  expect(view.element.textContent).toContain('原消息最初的执行选择无法核实')
})


it('consumes declared native steer for explicit Mobile send', async () => {
 const f = consumer()
 expect(f.client.catalog().find(p => p.id === 'codex')!.capabilities.promptExecution).toEqual({immediate: 'native-steer'})
 const view = await mount(<MobileConversationSurface {...f.options} />)
 await paste(view.element, body)
 await click(button(view.element, 'Send'))
 await settled(() => expect(f.submit).toHaveBeenCalledOnce())
 expect(f.submit.mock.calls[0]![0]).toMatchObject({prompt: body,execution: 'immediate',allowUncertainTurn: true})
})
