import { afterEach, expect, test, vi } from 'vitest'
import { AgentMuxError } from '../src/errors.js'
import { createSpaceSessionsFixture } from './helpers/space-session-fixture.js'
import { spaceMemberRuntime } from '../src/space-member-runtime.js'
import { parseSpaceMemberParams } from '../src/space-member-codec.js'
import { encodeHostedValue } from '../src/hosted-value.js'
import type { AgentMuxRpcCallContext } from '../src/public-rpc-service.js'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })

async function fixture(method: 'submitAgentPrompt' | 'rejoinAgentInputWaiting' | 'writeAgent' = 'submitAgentPrompt', authority: Partial<AgentMuxRpcCallContext> = {}, controlled = true) {
  const f = await createSpaceSessionsFixture(cleanup), session = await f.b.put('original-member')
  const admitted = await f.admit('local', f.b.owner.runtimeId, session.agentSessionId, 'original-C')
  const key = { kind: 'prompt' as const, agentSessionId: session.agentSessionId, expectedRun: session.run, submissionId: 'original-input' }
  const args = method === 'submitAgentPrompt' ? [{ agentSessionId: key.agentSessionId, expectedRun: key.expectedRun, operationId: key.submissionId,
    ...(controlled ? { admissionIntent: { kind: 'session-conversation' } } : {}), prompt: 'Original body' }]
    : method === 'rejoinAgentInputWaiting' ? [{ ref: { key, waitGeneration: 1 } }]
    : [{ agentSessionId: key.agentSessionId, expectedRun: key.expectedRun, data: 'raw', source: 'user' }]
  const input = parseSpaceMemberParams('space.member.call', { target: { reference: f.reference, regionId: admitted.address.regionId,
    runtimeId: f.b.owner.runtimeId, agentSessionId: key.agentSessionId, expectedRun: key.expectedRun, expectedAdmission: { kind: 'creation', operationId: 'original-C' } },
    call: { method: 'runtime.invoke', params: { consumerId: 'original-reader', fence: { runtimeId: f.b.owner.runtimeId, ownerInstanceId: f.b.owner.ownerInstanceId },
      invocation: encodeHostedValue({ method, args }) } } })
  const reader = new AbortController()
  const scope = await spaceMemberRuntime({ store: f.b.spatial, clients: async () => [], local: {
    call: (method, params, context) => f.b.server.callRpc(method, params as never, context),
    subscribe: async () => { throw Error('This accepted-input restriction has no observation stream') }
  } }, input, { transport: 'unix', principal: { kind: 'user', id: 'original-actor' }, signal: reader.signal, ...authority })
  return { ...f, key, session, admitted, reader, scope }
}

test.each(['submitAgentPrompt', 'rejoinAgentInputWaiting'] as const)('accepted %s retains its original member restriction after only the reader closes', async method => {
  const f = await fixture(method), retain = f.scope.context.retainAcceptedInputAuthority
  expect(retain).toBeTypeOf('function')
  const accepted = await retain!(f.key)
  f.reader.abort()
  await expect(f.scope.assertCurrent()).rejects.toMatchObject({ name: 'AbortError' })
  await expect(accepted.assertCurrent()).resolves.toBeUndefined()
  accepted.release()
  expect(await f.b.core.readAgentSession(f.key.agentSessionId)).toMatchObject({ run: f.key.expectedRun })
  expect(f.b.inventory).not.toHaveBeenCalled(); expect(f.b.runs).not.toHaveBeenCalled()
})

test('cancellation before Core acceptance ends only that intake attempt', async () => {
  const f = await fixture()
  f.reader.abort()
  await expect(f.scope.context.retainAcceptedInputAuthority!(f.key)).rejects.toMatchObject({ name: 'AbortError' })
  expect(await f.b.core.readAgentSession(f.key.agentSessionId)).toMatchObject({ run: f.key.expectedRun })
})

test.each(['Session', 'Run', 'operation', 'attempt'] as const)('another original %s cannot borrow the accepted member restriction', async field => {
  const upstream = vi.fn(async () => ({ assertCurrent: async () => {}, release() {} })), f = await fixture('submitAgentPrompt', { retainAcceptedInputAuthority: upstream })
  const changed = structuredClone(f.key)
  if (field === 'Session') changed.agentSessionId = 'another-member'
  if (field === 'Run') changed.expectedRun.runId = 'another-run'
  if (field === 'operation') changed.submissionId = 'another-input'
  const key = field === 'attempt' ? { ...changed, attemptId: 'another-attempt' } : changed
  await expect(f.scope.context.retainAcceptedInputAuthority!(key)).rejects.toMatchObject({ code: 'SPACE_MEMBER_TARGET_MISMATCH' })
  expect(upstream).not.toHaveBeenCalled()
})

test('the retained exact Source C is still checked without probing or stopping its healthy Agent', async () => {
  const f = await fixture(), accepted = await f.scope.context.retainAcceptedInputAuthority!(f.key)
  f.reader.abort()
  const state = (await f.b.spatial.read())!
  await f.b.spatial.commit({ expectedRevision: state.revision, graph: { ...state.graph,
    tabs: state.graph.tabs.map(tab => tab.tabId === f.admitted.address.tabId ? { ...tab, regionIds: [] } : tab),
    regions: state.graph.regions.filter(region => region.regionId !== f.admitted.address.regionId), tabLayouts: {} }, allowEntityRemoval: true })
  expect((await f.b.spatial.read())!.graph.regions.some(region => region.regionId === f.admitted.address.regionId)).toBe(false)
  await expect(accepted.assertCurrent()).rejects.toMatchObject({ code: 'SPACE_MEMBER_ADMISSION_UNCONFIRMED' })
  accepted.release()
  expect(await f.b.core.readAgentSession(f.key.agentSessionId)).toMatchObject({ run: f.key.expectedRun })
  expect(f.b.inventory).not.toHaveBeenCalled(); expect(f.b.runs).not.toHaveBeenCalled()
})

test('an original upstream owner transfers its live restriction and release rather than keeping the old reader authority', async () => {
  let revoked = false
  const original = new AbortController(), initial = vi.fn(async () => { original.signal.throwIfAborted() })
  const current = vi.fn(async () => { if (revoked) throw new AgentMuxError('Original receiver grant changed', 'HOST_ROUTE_GRANT_REVOKED') }), release = vi.fn()
  const upstream = vi.fn(async () => ({ assertCurrent: current, release }))
  const f = await fixture('rejoinAgentInputWaiting', { assertCurrent: initial, retainAcceptedInputAuthority: upstream })
  const accepted = await f.scope.context.retainAcceptedInputAuthority!(f.key)
  expect(upstream).toHaveBeenCalledExactlyOnceWith(f.key)
  const initialReads = initial.mock.calls.length
  original.abort(); f.reader.abort()
  await expect(accepted.assertCurrent()).resolves.toBeUndefined()
  expect(initial).toHaveBeenCalledTimes(initialReads)
  revoked = true
  await expect(accepted.assertCurrent()).rejects.toMatchObject({ code: 'HOST_ROUTE_GRANT_REVOKED' })
  accepted.release(); expect(release).toHaveBeenCalledOnce()
})

test('a direct original author restriction stays live after observation ends', async () => {
  let revoked = false
  const f = await fixture('submitAgentPrompt', { assertCurrent: async () => { if (revoked) throw new AgentMuxError('Original author changed', 'CONTROL_PERMISSION_DENIED') } })
  const accepted = await f.scope.context.retainAcceptedInputAuthority!(f.key)
  f.reader.abort(); revoked = true
  await expect(accepted.assertCurrent()).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  accepted.release()
})

test.each(['writeAgent', 'submitAgentPrompt'] as const)('uncontrolled %s keeps its original pre-dispatch request lifetime', async method => {
  const f = await fixture(method, {}, false)
  expect(f.scope.context.retainAcceptedInputAuthority).toBeUndefined()
  f.reader.abort()
  await expect(f.scope.assertCurrent()).rejects.toMatchObject({ name: 'AbortError' })
})
