import { afterEach, expect, it, vi } from 'vitest'
import { createSpaceSessionsFixture } from '../../../packages/core/test/helpers/space-session-fixture'
import { RuntimeController } from '../src/main/runtime-controller'
import type { AgentInputTarget } from '../src/shared/contracts'
import type { SpaceMountMemberTarget } from '../src/shared/space-mount'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })

async function fixture() {
  const f = await createSpaceSessionsFixture(cleanup), sid = 'same-original-input-sid'
  await f.b.put(sid)
  const session = await f.d.put(sid), admitted = await f.admit('D-in-B', f.d.owner.runtimeId, sid, 'original-input-C')
  const member: SpaceMountMemberTarget = { hostId: 'original-b-carrier', target: {
    reference: f.reference, regionId: admitted.address.regionId, runtimeId: f.d.owner.runtimeId,
    agentSessionId: sid, expectedRun: session.run, expectedAdmission: { kind: 'creation', operationId: 'original-input-C' }
  } }
  const target: AgentInputTarget = { kind: 'space-member-target', target: member }
  const hosts = new Map([['original-b-carrier', { client: {
    forwardRpc: f.b.rpc.call.bind(f.b.rpc), subscribeRpc: f.b.rpc.subscribe.bind(f.b.rpc)
  } }]])
  const runtime = Object.assign(Object.create(RuntimeController.prototype), {
    hosts, hostOperations: new Map(), hostReconfigurationReservations: new Set()
  }) as RuntimeController
  return { ...f, session, admitted, member, target, runtime, hosts }
}

it('submits and inspects only the original D Core input through the frozen member route', async () => {
  const f = await fixture()
  const observer = vi.spyOn(f.b.core, 'submitAgentPrompt').mockRejectedValue(Error('The observer-local same SID must not receive input'))
  const original = vi.spyOn(f.d.core, 'submitAgentPrompt')
  const observerSubmission = vi.spyOn(f.b.core, 'inspectAgentPromptSubmission').mockRejectedValue(Error('The observer-local submission must not be read'))
  const originalSubmission = vi.spyOn(f.d.core, 'inspectAgentPromptSubmission')
  const receipt = await f.runtime.submitPrompt(f.target, 'Original Source body', 'original-source-operation', {
    expectedRun: f.session.run, admissionIntent: { kind: 'manual-actor' }
  }, undefined, { execution: 'immediate' }, true, undefined, 'message-tool', undefined, undefined, { name: 'Original person' })
  expect(receipt).toMatchObject({ key: { kind: 'prompt', agentSessionId: f.member.target.agentSessionId,
    expectedRun: f.session.run, submissionId: 'original-source-operation' } })
  expect(original).toHaveBeenCalledOnce()
  expect(original.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
    agentSessionId: f.member.target.agentSessionId, expectedRun: f.session.run, operationId: 'original-source-operation',
    prompt: 'Original Source body', execution: 'immediate', authorHuman: true,
    authorProfile: { name: 'Original person' }, sourceChannel: 'message-tool'
  }))
  expect(observer).not.toHaveBeenCalled()
  if (!receipt || !('key' in receipt)) throw Error('Expected the original Core input receipt')
  await expect(f.runtime.inspectInput(f.target, receipt.key)).resolves.toMatchObject({ key: receipt.key })
  originalSubmission.mockClear(); observerSubmission.mockClear()
  await expect(f.runtime.inspectSubmission(f.target, receipt.key)).resolves.toBeNull()
  expect(originalSubmission).toHaveBeenCalledOnce()
  expect(originalSubmission.mock.calls[0]?.[0]).toEqual(receipt.key)
  expect(observerSubmission).not.toHaveBeenCalled()
  expect(original).toHaveBeenCalledOnce()
  expect(observer).not.toHaveBeenCalled()
})

it('keeps original waiting controls usable after each Main reader disposes and interrupts only the original Run', async () => {
  const f = await fixture()
  const receipt = await f.runtime.submitPrompt(f.target, 'Retain original waiting', 'original-waiting-operation', {
    expectedRun: f.session.run, admissionIntent: { kind: 'manual-actor' }
  }, undefined, { execution: 'immediate' }, true)
  if (!receipt || !('ref' in receipt)) throw Error('Expected original waiting reference')
  const observerStop = vi.spyOn(f.b.core, 'stopAgentInputWaiting').mockRejectedValue(Error('Wrong observer waiting control'))
  const observerRejoin = vi.spyOn(f.b.core, 'rejoinAgentInputWaiting').mockRejectedValue(Error('Wrong observer rejoin'))
  const stopped = await f.runtime.stopInputWaiting(f.target, receipt.ref, 'original-cancel-operation')
  expect(stopped).toMatchObject({ ref: receipt.ref, cancelOperationId: 'original-cancel-operation' })
  const rejoined = await f.runtime.rejoinInputWaiting(f.target, receipt.ref)
  expect(rejoined).toMatchObject({ key: receipt.key, ref: { key: receipt.key, waitGeneration: 2 } })
  const signal = vi.spyOn(f.d.core, 'signalAgent').mockResolvedValue()
  const observerSignal = vi.spyOn(f.b.core, 'signalAgent').mockRejectedValue(Error('Wrong observer Run'))
  await f.runtime.interrupt(f.target)
  expect(signal).toHaveBeenCalledExactlyOnceWith(f.member.target.agentSessionId, f.session.run, 'SIGINT')
  expect(observerStop).not.toHaveBeenCalled(); expect(observerRejoin).not.toHaveBeenCalled(); expect(observerSignal).not.toHaveBeenCalled()
})

it('rejects missing C/L, changed Run or admission and a changing carrier before any original input effect', async () => {
  const f = await fixture(), original = vi.spyOn(f.d.core, 'submitAgentPrompt')
  const missingAdmission = { kind: 'space-member-target', target: { ...f.member, target: { ...f.member.target, expectedAdmission: undefined } } } as unknown as AgentInputTarget
  const binding = { expectedRun: f.session.run, admissionIntent: { kind: 'manual-actor' as const } }
  await expect(f.runtime.submitPrompt(missingAdmission, 'Do not route', 'missing-C', binding, undefined, { execution: 'immediate' }, true))
    .rejects.toMatchObject({ code: 'SPACE_MEMBER_ADMISSION_UNCONFIRMED' })
  await expect(f.runtime.submitPrompt(f.target, 'Do not route', 'changed-run', { ...binding, expectedRun: { runId: 'another-run' } }, undefined, { execution: 'immediate' }, true))
    .rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  const changedAdmission: AgentInputTarget = { kind: 'space-member-target', target: { ...f.member, target: { ...f.member.target,
    expectedAdmission: { kind: 'creation', operationId: 'another-C' } } } }
  await expect(f.runtime.submitPrompt(changedAdmission, 'Do not route', 'changed-C', binding, undefined, { execution: 'immediate' }, true))
    .rejects.toMatchObject({ code: 'SPACE_MEMBER_ADMISSION_UNCONFIRMED' })
  expect(original).not.toHaveBeenCalled()
  const key = { kind: 'prompt' as const, agentSessionId: f.member.target.agentSessionId, expectedRun: f.session.run, submissionId: 'retained-unknown' }
  const inspect = vi.spyOn(f.d.core, 'inspectAgentInput')
  const reservations = (f.runtime as unknown as { hostReconfigurationReservations: Set<string> }).hostReconfigurationReservations
  reservations.add(f.member.hostId)
  await expect(f.runtime.inspectInput(f.target, key)).rejects.toThrow('Runtime host is being reconfigured')
  expect(inspect).not.toHaveBeenCalled()
  reservations.delete(f.member.hostId)
  await expect(f.runtime.inspectInput(f.target, { ...key, expectedRun: { runId: 'new-run' } })).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  expect(inspect).not.toHaveBeenCalled()
})
