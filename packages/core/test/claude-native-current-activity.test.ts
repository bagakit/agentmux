import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { activityCertaintyClient } from './fixtures/activity-certainty-client.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { agentTurnCompletionIdentity } from '../src/agent-session-identity.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
const native = (sequence: number, turnId = 'native-turn-1', extra = {}) => ({
  session_id: 'native-main', sourceId: 'native-source', sequence, turnId, ...extra
})
async function harness(id = 'native-activity') {
  const h = await activityCertaintyClient(id, 'claude')
  closes.push(h.close)
  return h
}
async function start(h: Awaited<ReturnType<typeof harness>>, sequence = 1, turnId = 'native-turn-1') {
  await h.hook('turn.start', `start-${sequence}`, native(sequence, turnId))
}
async function end(h: Awaited<ReturnType<typeof harness>>, sequence = 2, turnId = 'native-turn-1', reason = 'answer') {
  await h.hook('turn.complete', `end-${sequence}`, native(sequence, turnId, { reason, isAborted: reason === 'aborted' }))
}

it.each(['answer', 'refusal', 'error', 'aborted'])('native %s end confirms current idle without manufacturing task success or readiness', async reason => {
  const h = await harness(`native-${reason}`)
  await start(h)
  expect((await h.client.statusAgent(`native-${reason}`)).observation.semantic).toBe('active')
  const before = (await h.sessions())[0]!
  await end(h, 2, 'native-turn-1', reason)
  const status = await h.client.statusAgent(`native-${reason}`)
  expect(status.observation).toMatchObject({ semantic: 'idle', readiness: 'ready', source: 'native-hook', stale: false })
  expect(status.session.currentActivity).toMatchObject({ state: 'idle', nativeTurnId: 'native-turn-1', run: { runId: h.run.runId } })
  expect(status.session.semanticStatus?.state).toBe(reason === 'error' ? 'error' : 'working')
  if (reason === 'error') expect(status.session.terminalPromptReadiness?.source).toBe('native-stop')
  else expect(status.session.terminalPromptReadiness).toEqual(before.terminalPromptReadiness)
  expect(agentTurnCompletionIdentity(status.session)).toBeUndefined()
  expect((await h.sessions())[0]).not.toHaveProperty('currentActivity')
  expect(status.session.semanticStatus!.currentActivityRevision).toBeGreaterThan(before.semanticStatus!.currentActivityRevision ?? 0)
})

it('pre-decision Stop and idle notification cannot end work; duplicate or late native ends cannot cover a new turn', async () => {
  const h = await harness()
  await start(h)
  await h.hook('Stop', 'veto-stop', { session_id: 'native-main' })
  await h.hook('Notification', 'old-idle', { session_id: 'native-main', notification_type: 'idle_prompt' })
  expect((await h.client.statusAgent('native-activity')).observation.semantic).toBe('active')
  await end(h)
  const first = h.client.agentSession('native-activity').currentActivity
  await h.hook('turn.complete', 'duplicate-native-end', native(2, 'native-turn-1', { reason: 'answer', isAborted: false }))
  expect(h.client.agentSession('native-activity').currentActivity).toEqual(first)
  await start(h, 4, 'native-turn-2')
  await end(h, 3, 'native-turn-1')
  await end(h, 5, 'native-turn-1')
  expect(h.client.agentSession('native-activity').currentActivity).toMatchObject({ state: 'active', nativeTurnId: 'native-turn-2' })
})

it('unknown initial end, foreign Session and another Run do not establish main idle', async () => {
  const h = await harness()
  await end(h, 3)
  expect(h.client.agentSession('native-activity').currentActivity).toBeUndefined()
  await start(h)
  await h.hook('turn.complete', 'foreign-end', native(2, 'native-turn-1', { session_id: 'foreign-main', reason: 'answer', isAborted: false }))
  await h.hook('turn.complete', 'old-run-end', native(2, 'native-turn-1', { reason: 'answer', isAborted: false }), 'retired-run')
  expect(h.client.agentSession('native-activity').currentActivity?.state).toBe('active')
})

it('main idle leaves actual child work and pending permission independent', async () => {
  const h = await harness()
  await start(h)
  await h.hook('turn.start', 'child-start', native(2, 'native-child-turn', {agent_id:'child-1'}))
  await end(h)
  expect(h.client.agentSession('native-activity').currentActivity).toBeUndefined()
  await h.hook('SubagentStop', 'predecision-child-stop', { session_id: 'native-main', agent_id: 'child-1' })
  expect(h.client.agentSession('native-activity').currentActivity).toBeUndefined()
  await h.hook('turn.complete', 'actual-child-end', native(4, 'native-child-turn', { agent_id: 'child-1', reason: 'answer', isAborted: false }))
  expect((await h.client.statusAgent('native-activity')).observation.semantic).toBe('idle')
  await h.hook('PermissionRequest', 'permission', { session_id: 'native-main', tool_name: 'Bash', tool_use_id: 'open-permission', tool_input: { command: 'true' } })
  const pending = h.client.agentSession('native-activity').pendingInteraction
  expect(pending).toBeDefined()
  await start(h, 5, 'native-turn-2'); await end(h, 6, 'native-turn-2')
  const status = await h.client.statusAgent('native-activity')
  expect(status.observation).toMatchObject({ semantic: 'awaiting-input', readiness: 'pending' })
  expect(status.session.pendingInteraction).toEqual(pending)
})

it('source gap and a genuine semantic claim consume idle; raw ACK does not act as a task boundary', async () => {
  const h = await harness()
  await start(h); await end(h)
  const before = h.client.agentSession('native-activity').currentActivity
  const kernel = (h.client as any).kernel
  kernel.identity = () => ({daemonInstanceId:'private-input-owner'})
  kernel.input = async (_id: string, input: {expectedByte:number;data:string}) => {
    h.run.acceptedInputBytes = input.expectedByte + Buffer.byteLength(input.data)
    return {run:h.run,appliedByteRange:{startByte:input.expectedByte,endByte:h.run.acceptedInputBytes}}
  }
  await h.client.writeAgent({agentSessionId:'native-activity',expectedRun:{runId:h.run.runId},data:'draft',source:'user'})
  expect(h.client.agentSession('native-activity').currentActivity).toEqual(before)
  await h.hook('AgentMuxActivityUnavailable', 'source-gap', { session_id: 'native-main', sourceId: 'native-source', sequence: 3, reason: 'source-changed' })
  expect(h.client.agentSession('native-activity').currentActivity?.state).toBe('unknown')
  await start(h, 4, 'native-turn-2'); await end(h, 5, 'native-turn-2')
  const inner = h.client as unknown as { registry: { update(id: string, run: {runId: string}, update: (s: any) => any): Promise<unknown> } }
  // The production semantic claim changes this exact durable owner field. No terminal bytes prove a claim.
  await inner.registry.update('native-activity', {runId: h.run.runId}, current => ({...current, promptCompletionAdmission: {
    submissionId: 'new-claim', operationId:'claim-operation', startByte:11, endByte:15, inputKey: {kind:'prompt', agentSessionId:'native-activity',expectedRun:{runId:h.run.runId},submissionId:'new-claim'},
    inputDispatch: {ref:{key:{kind:'prompt',agentSessionId:'native-activity',expectedRun:{runId:h.run.runId},submissionId:'new-claim'},waitGeneration:1},gateId:'claim'},
    outputCursorBytes: 17, intent: {run:{runId:h.run.runId},ownerInstanceId:'owner',prompt:'new',plan:{kind:'single-phase',data:'new\r'},execution:'immediate'}, acknowledged: false
  }}))
  expect(h.client.agentSession('native-activity').currentActivity?.state).toBe('unknown')
})

it('real public service and compiled inspect preserve the live fact and strict exact-Run codec rejects corruption', async () => {
  const h = await harness()
  await start(h); await end(h)
  const server = new AgentMuxControlServer({ socketPath: join(h.directory, 'activity.sock'), coreClients: () => [{ hostId: 'local', client: h.client }] })
  await server.start(); closes.push(() => server.stop())
  const result = await runCompiledObjectCli(['--endpoint', `unix:${server.path}`, 'agent', 'inspect', '--session', 'native-activity'], objectCliEnvironment(h.directory))
  expect(result.code, result.stderr).toBe(0)
  const value = JSON.parse(result.stdout).result
  expect(value.status.observation.semantic).toBe('idle')
  expect(value.status.session.currentActivity.nativeTurnId).toBe('native-turn-1')
  const params = { target: { kind: 'agent-session', agentSessionId: 'native-activity' } }
  expect(parseRpcNativeResult('agent.inspect', value, params)).toEqual(value)
  for (const corrupt of [(a: any) => {a.run.runId='old-run'},(a:any)=>{a.nativeSessionId='other'},(a:any)=>{a.sequence=0},(a:any)=>{a.state='done'}]) {
    const broken = structuredClone(value); corrupt(broken.status.session.currentActivity)
    expect(() => parseRpcNativeResult('agent.inspect', broken, params)).toThrow()
  }
})


it('a replaced source withdraws old idle visibly and cannot silently reclaim it', async () => {
  const h = await harness()
  await start(h); await end(h)
  await h.hook('turn.start', 'replacement-source', native(1, 'new-stream-turn', {sourceId:'new-source'}))
  const status = await h.client.statusAgent('native-activity')
  expect(status.observation).toMatchObject({semantic:'unknown',reason:'activity-unconfirmed'})
  expect(status.session.currentActivity?.state).toBe('unknown')
  expect(status.session.hookIngressObservation?.code).toBe('AGENT_NATIVE_ACTIVITY_UNAVAILABLE')
  await start(h, 4, 'late-retired-turn')
  expect((await h.client.statusAgent('native-activity')).observation.semantic).toBe('unknown')
})

it('a confirmed main failure supersedes an earlier active native observation', async () => {
  const h = await harness()
  await start(h)
  await h.hook('StopFailure','real-failure',{session_id:'native-main',error:'authentication_failed'})
  const status = await h.client.statusAgent('native-activity')
  expect(status.session.semanticStatus?.state).toBe('error')
  expect(status.session.currentActivity).toBeUndefined()
  expect(status.observation.semantic).toBe('idle')
})


it('an initial explicit source gap does not resurrect a durable idle conclusion or invent a turn ID', async () => {
  const h = await activityCertaintyClient('initial-gap','claude',{semanticStatus:{state:'done',source:'native-hook',observedAt:Date.now()}})
  closes.push(h.close)
  await h.hook('AgentMuxActivityUnavailable','initial-source-gap',{session_id:'native-main',sourceId:'native-source',sequence:2,reason:'delivery-gap'})
  const status = await h.client.statusAgent('initial-gap')
  expect(status.observation).toMatchObject({semantic:'unknown',reason:'activity-unconfirmed',readiness:'ready'})
  expect(status.session.currentActivity).toMatchObject({state:'unknown'})
  expect(status.session.currentActivity?.nativeTurnId).toBeUndefined()
  expect(status.session.semanticStatus?.state).toBe('done')
})

it('source sequence governs equal and backwards clocks without rewriting native observation time', async () => {
  const now = Date.now(), clock = vi.spyOn(Date,'now').mockReturnValue(now)
  try {
    const h = await harness()
    await start(h); await end(h)
    clock.mockReturnValue(now-1)
    await start(h,3,'next-native-turn')
    await end(h,2,'native-turn-1')
    const status = await h.client.statusAgent('native-activity')
    expect(status.observation.semantic).toBe('active')
    expect(status.session.currentActivity).toMatchObject({nativeTurnId:'next-native-turn',observedAt:now-1})
  } finally {clock.mockRestore()}
})

it.each([
  { childId: 'same-child', startOld: true },
  { childId: 'new-child', startOld: true },
  { childId: 'first-child', startOld: false }
])('a child source replacement ($childId) cannot let an old child end release main idle', async ({childId, startOld}) => {
  const id = `child-source-replacement-${childId}`
  const h = await activityCertaintyClient(id, 'claude')
  const payload = (sourceId: string, sequence: number, turnId: string, extra = {}) => ({ session_id: 'native-main', sourceId, sequence, turnId, ...extra })
  try {
    await h.hook('turn.start', 'main-start-A', payload('source-A', 1, 'main-turn-A'))
    if (startOld) await h.hook('turn.start', 'child-start-A', payload('source-A', 2, 'child-turn-A', {agent_id:'same-child'}))
    await h.hook('turn.complete', 'main-end-A', payload('source-A', 3, 'main-turn-A', {reason:'answer',isAborted:false}))
    if (startOld) expect(h.client.agentSession(id).currentActivity).toBeUndefined()
    await h.hook('turn.start', 'child-start-B', payload('source-B', 1, 'child-turn-B', {agent_id:childId}))
    await h.hook('turn.complete', 'late-child-end-A', payload('source-A', 4, 'child-turn-A', {agent_id:'same-child',reason:'answer',isAborted:false}))
    const status = await h.client.statusAgent(id)
    expect(status.observation.semantic).toBe('unknown')
    expect(status.session.currentActivity?.state).toBe('unknown')
    expect(status.session.hookIngressObservation?.code).toBe('AGENT_NATIVE_ACTIVITY_UNAVAILABLE')
    await h.hook('turn.complete', 'child-end-B', payload('source-B', 2, 'child-turn-B', {agent_id:childId,reason:'answer',isAborted:false}))
    expect((await h.client.statusAgent(id)).observation.semantic).toBe('unknown')
    await h.hook('PermissionRequest', 'permission-after-source-conflict', {session_id:'native-main', tool_name:'Bash', tool_use_id:'source-conflict-permission', tool_input:{command:'true'}})
    expect((await h.client.statusAgent(id)).observation.semantic).toBe('awaiting-input')
    expect(h.client.agentSession(id).pendingInteraction?.request.kind).toBe('permission')
    await h.hook('StopFailure', 'failure-after-source-conflict', {session_id:'native-main', error:'native failure'})
    expect(h.client.agentSession(id).semanticStatus?.state).toBe('error')
  } finally { await h.close() }
})


it('an actor capture failure remains a visible diagnostic without inventing native identity or consuming capability', async () => {
  const h = await harness('actor-capture-failure')
  const before = h.client.agentSession('actor-capture-failure')
  const capability = (await h.client.statusAgent('actor-capture-failure')).capabilities
  await h.hook('AgentMuxActivityUnavailable', 'actor-unavailable', {
    sourceId:'uncaptured-source', sequence:1, reason:'source-identity-unavailable'
  })
  await h.hook('Notification', 'independent-raw-ack', {})
  const after = await h.client.statusAgent('actor-capture-failure')
  expect(after.session.hookIngressObservation).toMatchObject({code:'AGENT_NATIVE_ACTIVITY_UNAVAILABLE', run:before.run})
  expect(after.session.nativeHandle).toEqual(before.nativeHandle)
  expect(after.session.semanticStatus).toEqual(before.semanticStatus)
  expect(after.session.currentActivity).toBeUndefined()
  expect(after.capabilities).toEqual(capability)
  expect(after.run.state).toBe('running')
})
