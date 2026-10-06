import { fixtureEpoch as _liveTailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentInputSubmissionReceipt } from '@agentmux/core'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../src/platform/browser'
import { DeviceWorkfaceStore, emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { acceptedPrompt, button, click, deferred, editor, fixture, mount, mounted, paste } from './conversation-fixture'

const draftKey = JSON.stringify(['draft', 'session-original'])
const body = 'A distinct explicit input for the original terminal'
const props = (f: ReturnType<typeof fixture>) => ({ client: f.client, agentSessionId: 'session-original',
  connection: { state: 'connected' as const, message: 'Private original connection' }, platform: createBrowserPlatform({ clipboard: { writeText: vi.fn(async () => {}) } }) })
const attempt = () => getDeviceWorkface().snapshot().record.conversation.attempts.find(([key]) => key === draftKey)![1]
async function receiptFor(input: Parameters<typeof acceptedPrompt>[0]) {
  const receipt = await acceptedPrompt(input)
  if (!receipt) throw new Error('The actual explicit producer must send manual-actor')
  return receipt
}
function waiting(receipt: AgentInputSubmissionReceipt): AgentInputSubmissionReceipt {
  return { ...receipt, admission: null, status: 'waiting', observation: 'rejoin-needed', control: { ref: receipt.ref, state: 'enabled', at: _liveTailFixtureEpoch(0, 0, 1),
    waiting: { phase: 'input-environment', reason: 'original-input-unconfirmed', wake: 'explicit-rejoin', failure: { name: 'AgentMuxError', message: 'Original input observation pending' } } } }
}
async function settled(check: () => void) { await act(async () => { await vi.waitFor(check) }) }
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => { for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }; vi.restoreAllMocks() })

it('sends a new manual input without catalog or predecessor gates and keeps first-save waiting distinct from terminal confirmation', async () => {
  const f = fixture()
  f.client.catalog = () => { throw Error('Catalog observation is unavailable') }
  f.sessions.get('session-original')!.promptCompletionAdmission = { operationId: 'older-opaque', startByte: 0, endByte: 1 }
  let current: AgentInputSubmissionReceipt | undefined
  f.submit.mockImplementation(async input => current = waiting(await receiptFor(input)))
  const v = await mount(<MobileConversationSurface {...props(f)} />)
  await paste(v.element, body); await click(button(v.element, 'Send'))
  await settled(() => expect(attempt().phase).toBe('unknown'))
  expect(f.submit).toHaveBeenCalledOnce()
  expect(f.submit.mock.calls[0]![0]).toMatchObject({ prompt: body, authorHuman: true, execution: 'immediate', admissionIntent: { kind: 'manual-actor' }, expectedRun: { runId: 'run-original' } })
  expect(f.submit.mock.calls[0]![0]).not.toHaveProperty('afterSubmissionId')
  expect(attempt().manualInput).toMatchObject({ agentSessionId: 'session-original', expectedRun: { runId: 'run-original' }, runtimeId: 'original-runtime' })
  expect(attempt()).not.toHaveProperty('request')
  expect(editor(v.element).textContent).toBe(body)
  expect(v.element.querySelector('[data-kind="saved-waiting"]')).not.toBeNull()
  expect(v.element.querySelector('[data-kind="terminal-confirmed"]')).toBeNull()
  const terminal = await receiptFor(f.submit.mock.calls[0]![0])
  await act(async () => f.emit({ type: 'agent-input', receipt: terminal }))
  await settled(() => expect(attempt().phase).toBe('confirmed'))
  expect(editor(v.element).textContent).toBe('')
  expect(v.element.querySelector('[data-kind="terminal-confirmed"]')!.textContent).toContain('Native 是否采用尚未确认')
  expect(v.element.textContent).toContain('不是任务完成回执')
  await act(async () => f.emit({ type: 'agent-input', receipt: current! }))
  expect(attempt().phase).toBe('confirmed')
  expect(f.submit).toHaveBeenCalledOnce()
})

it('does not turn a late first-save ACK or captured timeline into terminal adoption and retains a neighboring draft', async () => {
  const f = fixture(), reply = deferred<AgentInputSubmissionReceipt>()
  f.submit.mockImplementation(() => reply.promise)
  const v = await mount(<MobileConversationSurface {...props(f)} />)
  await paste(v.element, body); await click(button(v.element, 'Send'))
  await settled(() => expect(f.submit).toHaveBeenCalledOnce())
  const terminal = await receiptFor(f.submit.mock.calls[0]![0]), saved = waiting(terminal)
  await act(async () => f.emit({ type: 'agent-input', receipt: saved }))
  await paste(v.element, ' Neighbor draft')
  const neighbor = editor(v.element).textContent
  f.setTimeline({ agentSessionId: 'session-original', revision: 2, items: [{ id: `prompt:${terminal.key.kind === 'prompt' ? terminal.key.submissionId : ''}`,
    agentSessionId: 'session-original', kind: 'user_message', content: body, status: 'complete', title: 'Captured input', source: 'agentmux', createdAt: _liveTailFixtureEpoch(0, 0, 1), updatedAt: _liveTailFixtureEpoch(0, 0, 1) }] })
  await act(async () => f.emit({ type: 'agent-timeline', agentSessionId: 'session-original', revision: 2 }))
  expect(attempt().phase).toBe('unknown')
  await act(async () => f.emit({ type: 'agent-input', receipt: terminal }))
  await act(async () => reply.resolve(saved))
  await settled(() => expect(attempt().phase).toBe('confirmed'))
  expect(editor(v.element).textContent).toBe(neighbor)
  expect(attempt().draft).toBe(body)
})

it('cold-reads the original manual key without replay and explicitly rejoins its exact generation', async () => {
  const f = fixture()
  let saved: AgentInputSubmissionReceipt | undefined
  f.submit.mockImplementation(async input => saved = waiting(await receiptFor(input)))
  const v = await mount(<MobileConversationSurface {...props(f)} />)
  await paste(v.element, body); await click(button(v.element, 'Send'))
  await settled(() => expect(attempt().phase).toBe('unknown'))
  const original = structuredClone(attempt())
  const first = mounted.pop()!; await act(async () => first.root.unmount()); first.element.remove()
  expect(new DeviceWorkfaceStore(() => localStorage).snapshot().record.conversation.attempts[0]![1]).toEqual(original)
  f.inspectInput.mockResolvedValue(saved!)
  f.rejoinInput.mockImplementation(async ({ ref }) => ({ ...saved!, ref: { ...ref, waitGeneration: 2 }, control: { ...saved!.control, ref: { ...ref, waitGeneration: 2 } } }))
  const cold = await mount(<MobileConversationSurface {...props(f)} />)
  await settled(() => expect(f.inspectInput).toHaveBeenCalledWith({ key: saved!.key }))
  expect(f.submit).toHaveBeenCalledOnce()
  await click(button(cold.element, '继续确认'))
  await settled(() => expect(f.rejoinInput).toHaveBeenCalledExactlyOnceWith({ ref: saved!.ref }))
  expect(f.submit).toHaveBeenCalledOnce()
  expect(attempt().operationId).toBe(original.operationId)
  expect(attempt().draft).toBe(body)
})

it('preserves a lost stop ACK identity across cold read and honors its confirmed stop even if follow-up inspect fails', async () => {
  const f = fixture()
  let saved: AgentInputSubmissionReceipt | undefined
  f.submit.mockImplementation(async input => saved = waiting(await receiptFor(input)))
  f.stopInput.mockRejectedValueOnce(Object.assign(new Error('Stop ACK lost'), { controlFailure: { disposition: 'unknown', confirmedInputBytes: 0 } }))
  const v = await mount(<MobileConversationSurface {...props(f)} />)
  await paste(v.element, body); await click(button(v.element, 'Send'))
  await settled(() => expect(attempt().phase).toBe('unknown'))
  await click(button(v.element, '停止等待'))
  await settled(() => expect(attempt().logId).toBeDefined())
  const originalStop = structuredClone(attempt().manualInput!.stopIntent!)
  expect(f.stopInput).toHaveBeenCalledExactlyOnceWith(originalStop)
  const first = mounted.pop()!; await act(async () => first.root.unmount()); first.element.remove()
  f.inspectInput.mockResolvedValue(saved!)
  const cold = await mount(<MobileConversationSurface {...props(f)} />)
  await settled(() => expect(f.inspectInput).toHaveBeenCalled())
  f.stopInput.mockImplementation(async input => ({ ...input, outcome: 'stopped-before-dispatch', at: _liveTailFixtureEpoch(0, 0, 2) }))
  f.inspectInput.mockRejectedValueOnce(Object.assign(new Error('Observation unavailable after stop ACK'), { controlFailure: { disposition: 'unknown', confirmedInputBytes: 0 } }))
  await click(button(cold.element, '重试停止等待'))
  await settled(() => expect(attempt().manualInput!.stopReceipt?.outcome).toBe('stopped-before-dispatch'))
  expect(f.stopInput.mock.calls).toEqual([[originalStop], [originalStop]])
  expect(cold.element.querySelector('[data-kind="stopped"]')).not.toBeNull()
  expect(f.submit).toHaveBeenCalledOnce()
  expect(attempt().draft).toBe(body)
})

it('keeps an old exact request on its original condition rather than upgrading its retry to manual', async () => {
  const request = { condition: { expectedRun: { runId: 'run-original' }, afterSubmissionId: 'original-predecessor' }, execution: 'immediate' as const,
    explicit: true, runtimeId: 'original-runtime' }
  await getDeviceWorkface().updateConversation({ version: 1, drafts: [[draftKey, body]], responses: [], attempts: [[draftKey, {
    operationId: 'original-exact', runId: 'run-original', draft: body, phase: 'unknown', request, inputRequested: true,
    originalRuntimeId: 'original-runtime', originalHostId: 'host-original', explicit: true }]] })
  const f = fixture(), v = await mount(<MobileConversationSurface {...props(f)} />)
  await click(button(v.element, '重试原请求'))
  await settled(() => expect(attempt().phase).toBe('confirmed'))
  expect(f.submit).toHaveBeenCalledExactlyOnceWith({ agentSessionId: 'session-original', operationId: 'original-exact', prompt: body, authorHuman: true,
    ...request.condition, execution: 'immediate', allowUncertainTurn: true })
  expect(f.inspectInput).not.toHaveBeenCalled(); expect(f.rejoinInput).not.toHaveBeenCalled()
  expect(attempt()).not.toHaveProperty('manualInput')
})


it('uses the typed whole-operation nonapplication receipt for an explicit new intent while preserving the refused identity', async () => {
  const f = fixture()
  f.submit.mockImplementationOnce(async input => {
    const receipt = await receiptFor(input), claim = receipt.admission!.admission!
    if(claim.transport!=='pty')throw Error('Private original terminal claim required')
    claim.acknowledged = false; claim.notApplied = true
    return { ...receipt, status: 'not-applied' }
  })
  const view = await mount(<MobileConversationSurface {...props(f)} />)
  await paste(view.element, body); await click(button(view.element, 'Send'))
  await settled(() => expect(attempt().phase).toBe('rejected'))
  const original = structuredClone(attempt())
  await click(button(view.element, '重新发送原正文'))
  await settled(() => expect(attempt().phase).toBe('confirmed'))
  expect(f.submit).toHaveBeenCalledTimes(2)
  expect(f.submit.mock.calls[1]![0].operationId).not.toBe(original.operationId)
  expect(f.submit.mock.calls[1]![0].prompt).toBe(body)
  expect(getDeviceWorkface().snapshot().record.conversation.attempts.find(([key]) => key === JSON.stringify(['refused-prompt', 'session-original', original.operationId]))![1])
    .toMatchObject({ operationId: original.operationId, draft: body, phase: 'rejected' })
})

it('retains one PTY claim as phase evidence arrives and rejects a contradictory byte range without granting a new send', async () => {
  const f = fixture()
  let terminal: AgentInputSubmissionReceipt | undefined
  f.submit.mockImplementation(async input => {
    terminal = await receiptFor(input)
    terminal.admission!.admission!.intent!.plan = { kind: 'render-then-submit', payload: body, renderedText: body, submit: '\r' }
    return { ...terminal, status: 'unknown' }
  })
  const view = await mount(<MobileConversationSurface {...props(f)} />)
  await paste(view.element, body); await click(button(view.element, 'Send'))
  await settled(() => expect(attempt().phase).toBe('unknown'))
  const updated = structuredClone(terminal!)
  updated.admission!.terminalPromptSubmission = { run: updated.key.expectedRun, submissionId: attempt().operationId,
    promptDigest: 'original-payload-digest', outputCursorBytes: 0,
    payload: { operationId: 'original-payload', inputByteRange: { startByte: 0, endByte: 12 }, acknowledged: true },
    submit: { operationId: 'original-submit', inputByteRange: { startByte: 12, endByte: 13 }, acknowledged: true } }
  await act(async () => f.emit({ type: 'agent-input', receipt: updated }))
  expect(attempt().phase).toBe('confirmed')
  const conflict = structuredClone(updated)
  conflict.admission!.terminalPromptSubmission!.submit.inputByteRange.endByte++
  await act(async () => f.emit({ type: 'agent-input', receipt: conflict }))
  await settled(() => expect(attempt().logId).toBeDefined())
  expect(attempt().phase).toBe('confirmed')
  expect(view.element.querySelector('[data-kind="terminal-confirmed"]')).not.toBeNull()
  expect(f.submit).toHaveBeenCalledOnce()
})


it('inspects and stops the captured original input after the current Run changes without rerouting its key', async () => {
 const f=fixture();let receipt:AgentInputSubmissionReceipt|undefined
 f.submit.mockImplementation(async input=>receipt=waiting(await receiptFor(input)))
 const view=await mount(<MobileConversationSurface {...props(f)} />)
 await paste(view.element,body);await click(button(view.element,'Send'))
 await settled(()=>expect(attempt().phase).toBe('unknown'))
 const original=structuredClone(attempt()),current=f.sessions.get('session-original')!
 f.sessions.set('session-original',{...current,run:{runId:'replacement-run'}})
 f.inspectInput.mockResolvedValue(receipt!)
 f.stopInput.mockImplementation(async input=>({...input,outcome:'stopped-before-dispatch',at:_liveTailFixtureEpoch(0, 0, 2)}))
 await click(button(view.element,'停止等待'))
 await settled(()=>expect(attempt().manualInput!.stopReceipt).toBeDefined())
 expect(f.stopInput).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ref:receipt!.ref}))
 expect(f.inspectInput).toHaveBeenCalledWith({key:receipt!.key})
 expect(attempt().manualInput!.expectedRun).toEqual(original.manualInput!.expectedRun)
 expect(f.submit).toHaveBeenCalledOnce()
})


it('keeps exact input observation and stop available when current Runtime metadata is absent', async () => {
 const f=fixture();let receipt:AgentInputSubmissionReceipt|undefined
 f.submit.mockImplementation(async input=>receipt=waiting(await receiptFor(input)))
 const view=await mount(<MobileConversationSurface {...props(f)} />)
 await paste(view.element,body);await click(button(view.element,'Send'))
 await settled(()=>expect(attempt().phase).toBe('unknown'))
 f.client.runtimeOwnerIdentity=()=>null
 f.inspectInput.mockResolvedValue(receipt!)
 await act(async()=>f.emit({type:'connection-state',state:'restored',evidence:{source:'native-hook',observedAt:_liveTailFixtureEpoch(0, 0, 1),run:{runId:'run-original'}}}))
 expect(f.inspectInput).toHaveBeenCalledWith({key:receipt!.key})
 f.stopInput.mockImplementation(async input=>({...input,outcome:'stopped-before-dispatch',at:_liveTailFixtureEpoch(0, 0, 2)}))
 await click(button(view.element,'停止等待'))
 await settled(()=>expect(attempt().manualInput!.stopReceipt).toBeDefined())
 expect(f.stopInput).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ref:receipt!.ref}))
 expect(f.submit).toHaveBeenCalledOnce()
})
