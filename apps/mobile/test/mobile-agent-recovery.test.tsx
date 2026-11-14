import './mobile-lan-crypto.setup'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { recoverMobileAgent, mobileAgentRecoveryBusy } from '../src/conversation/mobile-agent-recovery'
import { MobileAgentActions } from '../src/conversation/MobileAgentActions'
import { emptyDeviceWorkface, getDeviceWorkface, DeviceWorkfaceStore } from '../src/recovery/device-workface'
import { button, deferred, fixture, mount, mounted, session } from './conversation-fixture'
import { hostedAgentSessionSummary } from '../../../packages/core/src/hosted-session-summary'
import { continuitySession, hostedContinuityFixture } from '../../../packages/core/test/helpers/hosted-continuity'

beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => { for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }; document.body.replaceChildren(); vi.restoreAllMocks() })
function setup() {
  const f = fixture(), original = { ...session(), hostId: 'local' }
  f.client.forwardRpc = vi.fn().mockResolvedValue({ routeHostId: 'original-route', session: original, unavailable: [] })
  f.client.ensureAgentContinuity = vi.fn(async input => {
    expect(getDeviceWorkface().snapshot().record.agentResumes?.at(-1)).toMatchObject({ phase: 'sending', input })
    return { kind: 'reattachable', session: original, previousRun: original.run, run: {} } as never
  })
  const onNotice = vi.fn(), request = { client: f.client, agentSessionId: original.agentSessionId, expectedHostId: 'original-route', isCurrent: () => true, onNotice }
  return { ...f, original, onNotice, request }
}
it('the explicit main-entry action retains the exact manual operation before the shared Hosted recovery call', async () => {
  const f = setup()
  expect(f.client.forwardRpc).not.toHaveBeenCalled()
  expect(f.client.ensureAgentContinuity).not.toHaveBeenCalled()
  await recoverMobileAgent(f.request)
  expect(f.client.forwardRpc).toHaveBeenCalledWith('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'session-original' } })
  const intent = getDeviceWorkface().snapshot().record.agentResumes!.at(-1)!
  expect(intent).toMatchObject({ hostId: 'local', phase: 'confirmed', input: { agentSessionId: 'session-original', expectedRun: f.original.run, trigger: 'manual' } })
  expect(Object.keys(intent.input).sort()).toEqual(['agentSessionId', 'expectedRun', 'operationId', 'trigger'])
  expect(new DeviceWorkfaceStore(() => localStorage).snapshot().record.agentResumes).toContainEqual(intent)
})
it.each([
  ['other-route', 'local', 'original-route'],
  ['other-route', 'local', 'local'],
  ['original-route', 'foreign-semantic-host', 'original-route'],
  [undefined, 'original-route', 'original-route']
])('does not mistake route %s / semantic Host %s for saved Host %s', async (routeHostId, hostId, expectedHostId) => {
  const f = setup()
  vi.mocked(f.client.forwardRpc!).mockResolvedValueOnce({ routeHostId, session: { ...f.original, hostId }, unavailable: [] } as never)
  await recoverMobileAgent({ ...f.request, expectedHostId })
  expect(f.client.ensureAgentContinuity).not.toHaveBeenCalled()
  expect(getDeviceWorkface().snapshot().record.agentResumes).toBeUndefined()
  expect(f.onNotice.mock.calls.at(-1)?.[1]).toContain('另一台 Mac')
})
it('an original unknown main-entry request is only inspected on the next explicit opening, never continued or replaced', async () => {
  const f = setup()
  vi.mocked(f.client.ensureAgentContinuity).mockRejectedValueOnce(new Error('Original receipt lost'))
  await recoverMobileAgent(f.request)
  const owner = getDeviceWorkface(), intent = owner.snapshot().record.agentResumes!.at(-1)!
  expect(intent.phase).toBe('unknown')
  // Summary metadata cannot settle an unknown recovery from a stale cache. The same
  // explicit opening still inspects the exact original Session and its operation.
  f.sessions.set(f.original.agentSessionId, hostedAgentSessionSummary(f.original))
  vi.mocked(f.client.forwardRpc!).mockResolvedValueOnce({ routeHostId: 'original-route', session: { ...f.original, continuityOperations: {
    [intent.input.operationId]: { operationId: intent.input.operationId, agentSessionId: f.original.agentSessionId, previousRun: f.original.run, kind: 'reattachable' }
  } }, unavailable: [] } as never)
  await recoverMobileAgent(f.request)
  expect(f.client.forwardRpc).toHaveBeenLastCalledWith('agent.inspect', { target: { kind: 'agent-session', agentSessionId: f.original.agentSessionId } })
  expect(f.client.ensureAgentContinuity).toHaveBeenCalledTimes(1)
  expect(owner.snapshot().record.agentResumes).toEqual([{ ...intent, phase: 'confirmed' }])
})
it('settles the exact pending recovery from public agent.inspect while the real summary cache omits historical operations', async () => {
  const original = continuitySession(), f = await hostedContinuityFixture([original])
  try {
    const client = await f.connect('summary'), owner = getDeviceWorkface()
    const pending = { runtimeId: f.owner.runtimeId, deviceHostId: null, hostId: original.hostId,
      input: { agentSessionId: original.agentSessionId, expectedRun: original.run, operationId: original.agentSessionId + '-operation-0', trigger: 'manual' as const }, phase: 'unknown' as const }
    await owner.retainAgentResume(pending, owner.recordIdentity())
    expect(client.agentSession(original.agentSessionId).continuity?.operationId).not.toBe(pending.input.operationId)
    expect(Object.hasOwn(client.agentSession(original.agentSessionId), 'continuityOperations')).toBe(false)
    expect(f.forwardCalls).toEqual([]); expect(f.ensure).not.toHaveBeenCalled()
    const onNotice = vi.fn()
    await recoverMobileAgent({ client, agentSessionId: original.agentSessionId, mode: 'inspect', isCurrent: () => true, onNotice })
    expect(f.forwardCalls).toEqual([{ method: 'agent.inspect', params: { target: { kind: 'agent-session', agentSessionId: original.agentSessionId } }, context: expect.objectContaining({ runtimeFence: { runtimeId: f.owner.runtimeId, ownerInstanceId: f.owner.ownerInstanceId } }) }])
    expect(owner.snapshot().record.agentResumes).toEqual([{ ...pending, phase: 'confirmed' }])
    expect(onNotice).toHaveBeenCalledWith('可以重新连回这个 Agent。')
    expect(f.ensure).not.toHaveBeenCalled()
    expect(Object.hasOwn(client.agentSession(original.agentSessionId), 'continuityOperations')).toBe(false)
    expect((await f.core.readAgentSession(original.agentSessionId))!.continuityOperations).toEqual(original.continuityOperations)
    expect(f.calls.filter(value => value.startsWith('runtime.invoke:'))).toEqual(['runtime.invoke:listRuns'])
  } finally { await f.dispose() }
})
it('shares only the original client/SID flight with a newly opened menu and releases its busy state on receipt loss', async () => {
  const f = setup(), held = deferred<any>(), copyText = vi.fn().mockResolvedValue(true)
  vi.mocked(f.client.ensureAgentContinuity).mockReturnValueOnce(held.promise)
  let running!: Promise<void>
  await act(async () => { running = recoverMobileAgent(f.request); await vi.waitFor(() => expect(f.client.ensureAgentContinuity).toHaveBeenCalledTimes(1)) })
  expect(mobileAgentRecoveryBusy(f.client, 'session-original')).toBe(true)
  expect(mobileAgentRecoveryBusy(f.client, 'another-session')).toBe(false)
  const view = await mount(<MobileAgentActions client={f.client} agentSessionId="session-original" connected copyText={copyText} />)
  expect(button(view.element, '正在核对对话…').disabled).toBe(true)
  await act(async () => { held.reject(new Error('Unknown original receipt')); await running })
  expect(button(view.element, '核对恢复结果').disabled).toBe(false)
  expect(mobileAgentRecoveryBusy(f.client, 'session-original')).toBe(false)
})
it('retains a late receipt only on the original device intent and does not publish it after navigation changes', async () => {
  const f = setup(), held = deferred<any>(); let current = true
  vi.mocked(f.client.ensureAgentContinuity).mockReturnValueOnce(held.promise)
  const running = recoverMobileAgent({ ...f.request, isCurrent: () => current })
  await vi.waitFor(() => expect(f.client.ensureAgentContinuity).toHaveBeenCalledTimes(1))
  current = false
  held.resolve({ kind: 'reattachable', session: f.original, previousRun: f.original.run, run: {} })
  await running
  expect(getDeviceWorkface().snapshot().record.agentResumes?.at(-1)?.phase).toBe('confirmed')
  expect(f.onNotice).not.toHaveBeenCalled()
})
it('stays quiet on a confirmed reattach when opening a conversation, and still reports an unconfirmed one', async () => {
  const quiet = setup()
  await recoverMobileAgent({ ...quiet.request, quietWhenConfirmed: true })
  expect(getDeviceWorkface().snapshot().record.agentResumes!.at(-1)).toMatchObject({ phase: 'confirmed' })
  expect(quiet.onNotice).not.toHaveBeenCalled()
  const explicit = setup()
  await recoverMobileAgent(explicit.request)
  expect(explicit.onNotice).toHaveBeenCalledWith('可以重新连回这个 Agent。')
  const unknown = setup()
  vi.mocked(unknown.client.ensureAgentContinuity).mockRejectedValueOnce(new Error('receipt lost'))
  await recoverMobileAgent({ ...unknown.request, quietWhenConfirmed: true })
  expect(unknown.onNotice).toHaveBeenCalledWith(expect.stringContaining('恢复未确认'), 'receipt lost')
})
