import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { ClientDeliveryDiagnostics } from '@agentmux/client-ui/delivery-diagnostics'
import { button, click, deferred, editor, fixture, mount, mounted, paste } from './conversation-fixture'

const sid = 'session-original', key = JSON.stringify(['draft', sid]), body = 'Original explicitly refused input'
const connection = { state: 'connected' as const, message: 'Connected to original Host' }
function record() { return getDeviceWorkface().snapshot().record.conversation }
function currentAttempt() { return record().attempts.find(([entry]) => entry === key)![1] }
function consumer() {
  const f = fixture()
  Object.assign(f.client, { runtimeOwnerIdentity: () => ({ runtimeId: 'original-runtime' }) })
  const surface = <MobileConversationSurface client={f.client} agentSessionId={sid} connection={connection}
    platform={createBrowserPlatform({ clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })} />
  return { ...f, surface }
}
function originalRefusal(f: ReturnType<typeof consumer>, operationId: string) {
  const current = f.sessions.get(sid)!
  const refused = { ...current, promptCompletionAdmission: { operationId: 'native-original-phase', submissionId: operationId,
    startByte: 0, endByte: body.length, acknowledged: false, notApplied: true,
    intent: { run: current.run, ownerInstanceId: 'original-native', prompt: body,
      plan: { kind: 'single-phase' as const, data: body } } } }
  f.sessions.set(sid, refused)
  f.emit({ type: 'agent-session', session: refused })
}
async function firstRefusal(f: ReturnType<typeof consumer>) {
  f.submit.mockImplementationOnce(async input => {
    originalRefusal(f, input.operationId!)
    throw Object.assign(new Error('Native confirmed original whole input was not applied'), { code: 'AGENT_PROMPT_INPUT_NOT_APPLIED', detail: 'not_applied' })
  })
  const view = await mount(f.surface)
  await paste(view.element, body); await click(button(view.element, 'Send'))
  await vi.waitFor(() => expect(currentAttempt().phase).toBe('rejected'))
  return { view, original: structuredClone(currentAttempt()) }
}
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  vi.restoreAllMocks()
})

it('uses a new operation only on an explicit Send after exact whole refusal, preserving the original request and diagnostic', async () => {
  const f = consumer(), { view, original } = await firstRefusal(f)
  expect(f.submit).toHaveBeenCalledOnce()
  await click(button(view.element, 'Send'))
  await vi.waitFor(() => expect(currentAttempt().phase).toBe('confirmed'))
  const next = f.submit.mock.calls[1]![0]
  expect(next.operationId).not.toBe(original.operationId)
  expect(next).toMatchObject({ prompt: body, expectedRun: original.request!.condition.expectedRun, afterSubmissionId: original.operationId })
  expect(record().attempts.some(([entry, value]) => entry !== key && value.operationId === original.operationId
    && value.draft === body && value.logId === original.logId && JSON.stringify(value.request) === JSON.stringify(original.request))).toBe(true)
})

it('explicitly resends the original refused body as a new intent while preserving a different edited draft', async () => {
  const f = consumer(), { view, original } = await firstRefusal(f)
  await paste(view.element, ' Different new draft')
  const edited = editor(view.element).textContent
  await click(button(view.element, '重新发送原正文'))
  await vi.waitFor(() => expect(currentAttempt().phase).toBe('confirmed'))
  expect(f.submit.mock.calls[1]![0]).toMatchObject({ prompt: body, afterSubmissionId: original.operationId })
  expect(f.submit.mock.calls[1]![0].operationId).not.toBe(original.operationId)
  expect(editor(view.element).textContent).toBe(edited)
  expect(record().drafts).toContainEqual([key, edited])
})

it('does not interpret a partially accepted payload refusal as whole input or replace an unknown request', async () => {
  const f = consumer()
  f.submit.mockImplementationOnce(async input => {
    originalRefusal(f, input.operationId!)
    const current = f.sessions.get(sid)!, admission = current.promptCompletionAdmission!
    const partial = { ...current, promptCompletionAdmission: { ...admission, intent: { ...admission.intent!,
      plan: { kind: 'render-then-submit' as const, payload: body, renderedText: body, submit: '\r' } } },
      terminalPromptSubmission: { submissionId: input.operationId!, run: current.run, promptDigest: 'original', outputCursorBytes: 0,
        payload: { operationId: admission.operationId, inputByteRange: { startByte: 0, endByte: body.length - 1 }, acknowledged: true },
        submit: { operationId: 'original-submit', inputByteRange: { startByte: body.length - 1, endByte: body.length }, acknowledged: false, notApplied: true } } }
    f.sessions.set(sid, partial); f.emit({ type: 'agent-session', session: partial })
    throw new Error('Lost acknowledgement after payload acceptance')
  })
  const view = await mount(f.surface); await paste(view.element, body); await click(button(view.element, 'Send'))
  await vi.waitFor(() => expect(currentAttempt().logId).toBeDefined())
  expect(currentAttempt().phase).toBe('unknown')
  const original = f.submit.mock.calls[0]![0]
  await click(button(view.element, '重试原请求'))
  await vi.waitFor(() => expect(f.submit).toHaveBeenCalledTimes(2))
  expect(f.submit.mock.calls[1]![0]).toEqual(original)
})

it.each(['runtime', 'host', 'run', 'operation'] as const)('does not settle a negative fact belonging to another %s', async target => {
  const f = consumer(); f.submit.mockRejectedValueOnce(new Error('Original acknowledgement unavailable'))
  const view = await mount(f.surface); await paste(view.element, body); await click(button(view.element, 'Send'))
  await vi.waitFor(() => expect(currentAttempt().phase).toBe('unknown'))
  const original = structuredClone(currentAttempt())
  await act(async () => {
    if (target === 'runtime') Object.assign(f.client, { runtimeOwnerIdentity: () => ({ runtimeId: 'another-runtime' }) })
    else if (target === 'host') f.sessions.get(sid)!.hostId = 'another-host'
    else if (target === 'run') f.sessions.get(sid)!.run = { runId: 'another-run' }
    originalRefusal(f, target === 'operation' ? 'another-operation' : original.operationId)
  })
  expect(currentAttempt()).toEqual(original)
  expect(button(view.element, '重试原请求')).toBeDefined()
  expect(f.submit).toHaveBeenCalledOnce()
})

it('keeps the original archived request and diagnostic when an old retry failure callback arrives after a new explicit Send', async () => {
  const f = consumer(), held = deferred<void>(), entered = deferred<void>()
  f.submit.mockRejectedValueOnce(new Error('Original ACK unavailable')).mockRejectedValueOnce(new Error('Retry ACK unavailable'))
  const failed = ClientDeliveryDiagnostics.prototype.failed
  let calls = 0
  vi.spyOn(ClientDeliveryDiagnostics.prototype, 'failed').mockImplementation(async function (this: ClientDeliveryDiagnostics, ...args) {
    const result = await failed.apply(this, args)
    if (++calls === 2) { entered.resolve(); await held.promise }
    return result
  })
  const view = await mount(f.surface); await paste(view.element, body); await click(button(view.element, 'Send'))
  await vi.waitFor(() => expect(currentAttempt().phase).toBe('unknown'))
  const original = structuredClone(currentAttempt())
  await click(button(view.element, '重试原请求')); await entered.promise
  await act(async () => originalRefusal(f, original.operationId))
  await vi.waitFor(() => expect(currentAttempt().phase).toBe('rejected'))
  await click(button(view.element, 'Send'))
  await vi.waitFor(() => expect(currentAttempt().phase).toBe('confirmed'))
  await act(async () => held.resolve())
  await paste(view.element, 'New independent draft after the late callback')
  await vi.waitFor(() => expect(record().drafts).toContainEqual([key, 'New independent draft after the late callback']))
  const archived = record().attempts.find(([entry, value]) => entry !== key && value.operationId === original.operationId)![1]
  expect(archived).toEqual({ ...original, phase: 'rejected' })
  expect(f.submit).toHaveBeenCalledTimes(3)
})
