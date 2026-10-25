import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { FeishuAdapter } from '../src/adapters/feishu/index.js'
import { queryFeedbackOperationId } from '../src/publication-query-feedback.js'
import type { PublicationOperation } from '../src/publication-store.js'
import type { FeishuHttpCall, FeishuHttpResponse } from './fixtures/feishu-publication.js'
import { AgentMuxError } from '@agentmux/core'
import { MoteChatStore } from '../src/mote-chat-store.js'
import { moteChatJourneyFixture } from './fixtures/mote-chat-journey.js'
import { feishuConfig } from './fixtures/feishu.js'
import { runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { feishuReactions } from './fixtures/feishu-reactions.js'
import { objectCliEnvironment } from '../../core/test/helpers/object-cli-rpc.js'

async function fixture(unknown = false, override?: (call: FeishuHttpCall, normal: FeishuHttpResponse) => FeishuHttpResponse | undefined) {
  const remote = feishuReactions(unknown ? (call) => ({ status: 200, body: { code: 0, data: call.method === 'POST' ? {} : { items: [], has_more: false } } }) : override)
  const reactions = remote.active
  const f = await moteChatJourneyFixture(0, 60000, 'headless', false, 'grok', remote.handle)
  const binding = (id: string) => { const store = new MoteChatStore(f.services.database!); return store.generation(store.admissionByIngress(id)!.generationId)!.binding! }
  const outbox = () => f.services.publication!.store
  const feedback = (id: string) => outbox().list(binding(id), 100).filter(value => value.queryFeedback?.ingressId === id && value.effect === 'upsert')
  const stages = (id: string) => feedback(id).map(value => value.queryFeedback!.stage)
  const pending = (id: string) => outbox().queryInputPending(binding(id), 0).rows
  const waiting = async (id: string) => {
    await expect.poll(async () => (await f.services.ingress!.inspect({ ingressId: id })).inputReceipt?.status, { timeout: 10000 }).toBe('waiting')
  }
  const idle = async (id: string) => {
    await expect.poll(() => {
      const observer = Reflect.get(f.services.publication!, 'lanes').get(binding(id).bindingId)?.queryInput
      return !!observer && Reflect.get(observer, 'work') === undefined
    }, { timeout: 10000 }).toBe(true)
  }
  const originalSubmit = f.submission.getMockImplementation()!
  let offline = false
  f.submission.mockImplementation(async (...args) => {
    if (offline) { f.inner.connected = false; f.inner.kernel.isConnected = () => false }
    return await originalSubmit(...args)
  })
  const restore = () => {
    f.inner.connected = true; f.inner.kernel.isConnected = () => true
    Reflect.get(f.client, 'publisher').publish({ type: 'connection-state', state: 'restored', evidence: { source: 'run-process', observedAt: Date.now() } })
  }
  return { ...f, get services() { return f.services }, get sdk() { return f.sdk }, remote, reactions, binding, outbox, feedback, stages, pending, waiting, idle, restore,
    setOffline() { offline = true },
    cli: async (args: string[], input?: unknown) => {
      const result = await runCompiledObjectCli(['--endpoint', 'unix:' + join(f.root, 'public.sock'), ...args], objectCliEnvironment(f.root), input ? JSON.stringify(input) : '', 30000)
      expect(result.code, result.stdout + result.stderr).toBe(0); return JSON.parse(result.stdout).result
    }
  }
}

function evidence(name: string, facts: unknown): void {
  if (process.env.AGENTMUX_TEST_REACTION_FACTS) appendFileSync(process.env.AGENTMUX_TEST_REACTION_FACTS, JSON.stringify({ name, facts }) + '\n')
}

it('replacement keeps one current managed marker, original facts and unrelated reactions across public SDK, compiled CLI and Host reopen', async () => {
  const f = await fixture(); f.setOffline()
  const path = '/open-apis/im/v1/messages/' + encodeURIComponent('message/replacement') + '/reactions'
  const unrelated = [f.remote.seed(path, 'OneSecond', { operator_type: 'user', operator_id: 'another-person' }),
    f.remote.seed(path, 'OneSecond', { operator_type: 'app', operator_id: 'another-app' }), f.remote.seed(path, 'SMILE')]
  await f.wire.post(f.message('replacement')); const query = await f.claimed('replacement')
  await expect.poll(() => f.feedback(query.ingressId).find(value => value.queryFeedback?.stage === 'received')?.state).toBe('confirmed')
  const waiting = f.feedback(query.ingressId).find(value => value.queryFeedback?.stage === 'received')!
  await f.waiting(query.ingressId)
  const originalInput = (await f.services.ingress!.inspect({ ingressId: query.ingressId })).inputReceipt!
  expect(originalInput.status).toBe('waiting')
  expect(f.stages(query.ingressId)).toEqual(['received'])
  expect(f.remote.created.filter(value => value.reaction_type.emoji_type === 'OneSecond')).toHaveLength(1)
  await f.waiting(query.ingressId); f.restore()
  const managed = () => f.reactions.filter(value => !unrelated.includes(value))
  try { await expect.poll(() => managed().map(value => value.reaction_type.emoji_type), { timeout: 10000 }).toEqual(['Get']) }
  catch (error) {
    evidence('replacement-markers', { active: managed(), calls: f.remote.calls })
    expect(managed().map(value => value.reaction_type.emoji_type), 'Confirmed stages must replace older managed markers').toEqual(['Get'])
    throw error
  }
  const operations = () => f.outbox().list(f.binding(query.ingressId), 100).filter(value => value.queryFeedback?.ingressId === query.ingressId)
  await expect.poll(() => operations().find(value => value.predecessorOperationId === waiting.operationId)?.state).toBe('confirmed')
  const removed = operations().find(value => value.predecessorOperationId === waiting.operationId)!
  expect(removed).toMatchObject({ effect: 'withdraw', queryFeedback: waiting.queryFeedback, mapping: waiting.mapping, state: 'confirmed' })
  expect(f.reactions.filter(value => unrelated.includes(value))).toEqual(unrelated)
  const add = f.remote.calls.findIndex(call => call.method === 'POST' && JSON.parse(call.body).reaction_type.emoji_type === 'Get')
  const retire = f.remote.calls.findIndex(call => call.method === 'DELETE' && call.path.endsWith('/' + waiting.mapping!.reactionId))
  expect(add).toBeGreaterThanOrEqual(0); expect(retire).toBeGreaterThan(add)
  const sdk = await f.sdk.call('connection.delivery.inspect', { operationId: removed.operationId })
  expect(sdk.delivery).toMatchObject({ effect: 'withdraw', queryFeedback: waiting.queryFeedback, mapping: waiting.mapping, state: 'confirmed' })
  expect((await f.cli(['connection', 'delivery', 'inspect', '--operation-id', removed.operationId])).delivery).toEqual(sdk.delivery)
  expect((await f.cli(['connection', 'delivery', 'inspect', '--operation-id', waiting.operationId])).delivery).toMatchObject({ effect: 'upsert', state: 'confirmed', mapping: waiting.mapping })
  const frozen = operations(), writes = f.remote.calls.filter(call => call.method !== 'GET').length
  await f.restart(); await f.wire.post(f.message('replacement')); await f.idle(query.ingressId)
  expect(operations()).toEqual(frozen); expect(f.remote.calls.filter(call => call.method !== 'GET')).toHaveLength(writes)
  expect((await f.services.ingress!.inspect({ ingressId: query.ingressId })).inputReceipt!.ref).toEqual(originalInput.ref)
  expect(f.submission).toHaveBeenCalledOnce(); expect(f.start).toHaveBeenCalledOnce()
  evidence('replacement', { operations: frozen, calls: f.remote.calls, unrelated, active: f.reactions, sdk })
}, 30000)


it.each(['confirmed', 'unknown', 'retried-cleanup'] as const)('retained %s Get shares its native mapping with delivered Get across reopen without deleting either receipt', async originalState => {
  let originalReaction: ReturnType<ReturnType<typeof feishuReactions>['seed']> | undefined, failedCleanup: PublicationOperation | undefined
  let rejectCleanup = false
  const f: Awaited<ReturnType<typeof fixture>> = await fixture(false, (call, normal) => {
    if (rejectCleanup && call.method === 'DELETE') return { status: 200, body: { code: 231002 } }
    if (originalReaction && call.method === 'POST' && JSON.parse(call.body).reaction_type.emoji_type === 'Get') {
      // Native duplicate creation can return the exact already-present reaction.
      const added = (normal.body as { data: typeof originalReaction }).data!
      const index = f.reactions.indexOf(added)
      if (index >= 0) f.reactions.splice(index, 1)
      return { status: 200, body: { code: 0, data: originalReaction } }
    }
  }); f.setOffline()
  await f.wire.post(f.message('retained-' + originalState)); const query = await f.claimed('retained-' + originalState)
  await f.waiting(query.ingressId)
  await expect.poll(() => f.feedback(query.ingressId).find(value => value.queryFeedback?.stage === 'received')?.state, { timeout: 10000 }).toBe('confirmed')
  f.services.publication!.close()
  const received = f.feedback(query.ingressId).find(value => value.queryFeedback?.stage === 'received')!
  originalReaction = f.reactions.find(value => value.reaction_id === received.mapping!.reactionId)!
  // Load a historical persisted operation, not a new request under the old policy.
  originalReaction.reaction_type.emoji_type = 'Get'
  const prepared = { ...received.prepared!, renderVersion: 'feishu-conversation-v12', request: {
    ...received.prepared!.request, body: JSON.stringify({ reaction_type: { emoji_type: 'Get' } }) } }
  const state = originalState === 'unknown' ? 'unknown' : 'confirmed'
  const receipt = state === 'confirmed' ? received.receipt : { state: 'unknown' as const, reason: 'effect-unconfirmed' as const }
  const retained = { ...received, prepared, state, receipt }
  const db = f.services.database!
  db.prepare('UPDATE connector_publication_operation SET operation_json=?,state=? WHERE operation_id=?').run(JSON.stringify(retained), state, retained.operationId)
  db.prepare('UPDATE connector_publication_attempt SET receipt_json=? WHERE operation_id=? AND attempt=?').run(JSON.stringify(receipt), retained.operationId, retained.attempt!)
  if (originalState === 'retried-cleanup') {
    // Retain an old queued phase and its actual, definitively rejected cleanup.
    // Only historical row construction is controlled; claim, SDK transport,
    // reconciliation, receipts and the later public retry use production owners.
    const adapter = new FeishuAdapter({ http: f.feishu!.http }).publication, boundary = f.binding(query.ingressId)
    const operationId = queryFeedbackOperationId(boundary, query.ingressId, 'queued')
    const payload = { kind: 'query-feedback' as const, stage: 'queued' as const, messageId: query.externalMessageId }
    const { prepared: _prepared, attempt: _attempt, mapping: _mapping, receipt: _receipt, ...base } = received
    const queued: PublicationOperation = { ...base, operationId, projectionId: operationId.slice('publication-'.length),
      sourceRevision: createHash('sha256').update(JSON.stringify(payload)).digest('hex'), state: 'pending', payload,
      queryFeedback: { ...received.queryFeedback!, stage: 'queued' } }
    db.prepare('INSERT INTO connector_publication_operation (operation_id,projection_id,source_revision,fragment_ordinal,binding_id,binding_revision,operation_json,state) VALUES (?,?,?,?,?,?,?,?)')
      .run(queued.operationId, queued.projectionId, queued.sourceRevision, 0, queued.bindingId, queued.bindingRevision, JSON.stringify(queued), 'pending')
    const claimed = f.outbox().claimNext(boundary, queued.operationId, () => true, adapter)!
    expect(claimed).not.toBeNull()
    const delivered = await adapter.dispatch(claimed.prepared!, claimed.target, 'fixture-signing-key', new AbortController().signal)
    f.outbox().settle(claimed.operationId, claimed.attempt!, delivered)
    const cleanup = f.outbox().list(boundary, 100).find(value => value.predecessorOperationId === received.operationId)!
    const withdrawing = f.outbox().claimNext(boundary, cleanup.operationId, () => true, adapter)!
    rejectCleanup = true
    const rejected = await adapter.dispatch(withdrawing.prepared!, withdrawing.target, 'fixture-signing-key', new AbortController().signal, withdrawing.mapping)
    rejectCleanup = false
    expect(rejected).toEqual({ state: 'not-applied', reason: 'platform-rejected' })
    failedCleanup = f.outbox().settle(withdrawing.operationId, withdrawing.attempt!, rejected)
  }
  const postCount = f.remote.calls.filter(call => call.method === 'POST').length
  // Complete the original Core input while publication is closed, then recover
  // its exact delivery fact and the historical platform receipt in the reopened Host.
  f.restore()
  await expect.poll(async () => (await f.services.ingress!.inspect({ ingressId: query.ingressId })).inputReceipt?.status, { timeout: 10000 }).toBe('terminal-confirmed')
  await f.restart()
  try { await expect.poll(() => f.feedback(query.ingressId).find(value => value.queryFeedback?.stage === 'dispatched')?.state, { timeout: 10000 }).toBe('confirmed') }
  finally { evidence('retained-observation-' + originalState, { operations: f.feedback(query.ingressId), calls: f.remote.calls, input: await f.services.ingress!.inspect({ ingressId: query.ingressId }), observation: f.services.publication!.observation(f.binding(query.ingressId).bindingId, 1) }) }
  await expect.poll(() => f.outbox().inspect(retained.operationId)?.state, { timeout: 10000 }).toBe('confirmed')
  await f.idle(query.ingressId)
  const delivered = f.feedback(query.ingressId).find(value => value.queryFeedback?.stage === 'dispatched')!
  expect(delivered.mapping).toEqual(received.mapping)
  expect(f.reactions).toContain(originalReaction)
  if (failedCleanup) {
    const calls = f.remote.calls.filter(call => call.method === 'DELETE' && call.path.endsWith('/' + received.mapping!.reactionId)).length
    expect(calls).toBe(1)
    await f.sdk.call('connection.delivery.retry', { operationId: failedCleanup.operationId })
    await expect.poll(() => f.outbox().inspect(failedCleanup!.operationId)?.state, { timeout: 10000 }).toBe('superseded')
    expect(f.outbox().inspect(failedCleanup.operationId)).toMatchObject({ prepared: failedCleanup.prepared, attempt: failedCleanup.attempt, receipt: failedCleanup.receipt })
    expect(f.remote.calls.filter(call => call.method === 'DELETE' && call.path.endsWith('/' + received.mapping!.reactionId))).toHaveLength(calls)
    expect(f.reactions).toContain(originalReaction)
  } else {
    expect(f.remote.calls.some(call => call.method === 'DELETE' && call.path.endsWith('/' + received.mapping!.reactionId))).toBe(false)
    expect(f.outbox().list(f.binding(query.ingressId), 100).some(value => value.effect === 'withdraw')).toBe(false)
  }
  expect(f.outbox().inspect(retained.operationId)?.prepared).toEqual(prepared)
  expect(f.remote.calls.filter(call => call.method === 'POST')).toHaveLength(postCount + 1)
  expect((await f.sdk.call('connection.delivery.inspect', { operationId: retained.operationId })).delivery).toMatchObject({ state: 'confirmed', mapping: received.mapping })
  expect(f.submission).toHaveBeenCalledOnce(); expect(f.start).toHaveBeenCalledOnce()
  evidence('retained-' + originalState, { retained, delivered, calls: f.remote.calls, active: f.reactions })
}, 30000)

it('foreign reaction acknowledgement never becomes a managed mapping or a deletion target', async () => {
  const foreign = { reaction_id: 'foreign-owned', operator: { operator_type: 'app', operator_id: 'another-app' }, reaction_type: { emoji_type: 'OneSecond' } }
  const f = await fixture(false, (call) => {
    if (call.method === 'POST' && JSON.parse(call.body).reaction_type.emoji_type === 'OneSecond') return { status: 200, body: { code: 0, data: foreign } }
    if (call.method === 'GET' && call.query.reaction_type === 'OneSecond') return { status: 200, body: { code: 0, data: { items: [foreign], has_more: false } } }
  })
  const submit = f.submission.getMockImplementation()!; let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  f.submission.mockImplementation(async (...args) => { await held; return await submit(...args) })
  try {
    await f.wire.post(f.message('foreign'))
    await expect.poll(() => f.remote.created.filter(value => value.reaction_type.emoji_type === 'OneSecond').length).toBe(1)
  } finally { release() }
  const query = await f.claimed('foreign')
  await expect.poll(() => f.feedback(query.ingressId).find(value => value.queryFeedback?.stage === 'dispatched')?.state).toBe('confirmed')
  const received = f.feedback(query.ingressId).find(value => value.queryFeedback?.stage === 'received')!
  evidence('foreign-owner', { received, calls: f.remote.calls })
  expect(received.state).toBe('unknown'); expect(received.mapping).toBeUndefined()
  expect(f.remote.calls.some(call => call.method === 'DELETE' && call.path.endsWith('/foreign-owned'))).toBe(false)
  expect(f.submission).toHaveBeenCalledOnce()
}, 20000)

it('unknown cleanup preserves its frozen effect across reopen while new input and normal body delivery continue', async () => {
  const f = await fixture(false, call => call.method === 'DELETE' ? { status: 200, body: { code: 0, data: {} } } : undefined); f.setOffline()
  await f.wire.post(f.message('cleanup')); const query = await f.claimed('cleanup')
  await expect.poll(() => f.feedback(query.ingressId).find(value => value.queryFeedback?.stage === 'received')?.state).toBe('confirmed')
  await f.waiting(query.ingressId); f.restore()
  const effects = () => f.outbox().list(f.binding(query.ingressId), 100).filter(value => value.effect === 'withdraw')
  await expect.poll(() => effects().some(value => value.queryFeedback?.stage === 'received' && value.state === 'unknown')).toBe(true)
  const frozen = effects(), deletes = f.remote.calls.filter(call => call.method === 'DELETE').length
  await f.restart(); await f.idle(query.ingressId)
  expect(effects()).toEqual(frozen); expect(f.remote.calls.filter(call => call.method === 'DELETE')).toHaveLength(deletes)
  await f.reply(query.input!.agentSessionId, 'body-after-cleanup', 'Original body is independent of marker cleanup')
  await expect.poll(() => f.outbox().list(f.binding(query.ingressId), 100).some(value => value.payload.kind === 'speech' && value.state === 'confirmed')).toBe(true)
  const status = (f.inner.kernel.status as (id: string) => Promise<ReturnType<typeof f.run>>).bind(f.inner.kernel)
  f.inner.kernel.status = async (id: string) => ({ ...await status(id), acceptedInputBytes: f.run(id).acceptedInputBytes })
  // The independent query has its own original identity and uses the same healthy Run.
  await f.wire.post(f.message('after-cleanup')); const next = await f.claimed('after-cleanup'); f.restore()
  await expect.poll(async () => (await f.services.ingress!.inspect({ ingressId: next.ingressId })).inputReceipt?.status).toBe('terminal-confirmed')
  expect(next.input!.agentSessionId).toBe(query.input!.agentSessionId); expect(f.start).toHaveBeenCalledOnce()
  expect(f.remote.calls.filter(call => call.method === 'DELETE' && frozen.some(value => value.prepared!.request.path === call.path))).toHaveLength(deletes)
  evidence('unknown-cleanup', { frozen, calls: f.remote.calls, original: query.input, independent: next.input })
}, 30000)

it('a delayed original ACK retires its old marker without downgrading the newer stage or replaying skipped stages', async () => {
  const f = await fixture(false, call => call.method === 'GET' && call.query.reaction_type === 'OneSecond'
    ? { status: 200, body: { code: 0, data: { items: [], has_more: false } } } : undefined); f.setOffline()
  let releaseAck!: () => void, releaseInput!: () => void
  const ack = new Promise<void>(resolve => { releaseAck = resolve }), input = new Promise<void>(resolve => { releaseInput = resolve })
  const request = f.feishu!.http.request.bind(f.feishu!.http), submit = f.submission.getMockImplementation()!
  // Hold delivery of an actual SDK HTTP result after the server applied it. No
  // publication method/Store receipt is replaced; the original Host deadline runs.
  f.feishu!.http.request = async (...args: Parameters<typeof request>) => {
    const result: any = await request(...args)
    if (String(args[0].method).toUpperCase() === 'POST' && result?.data?.reaction_type?.emoji_type === 'OneSecond') await ack
    return result
  }
  f.submission.mockImplementation(async (...args) => { await input; return await submit(...args) })
  try {
    await f.wire.post(f.message('late'))
    await expect.poll(() => f.remote.created.some(value => value.reaction_type.emoji_type === 'OneSecond'), { timeout: 10000 }).toBe(true)
    releaseInput(); const query = await f.claimed('late')
    await expect.poll(() => f.stages(query.ingressId)).toContain('received')
    await f.waiting(query.ingressId); f.restore(); await expect.poll(() => f.stages(query.ingressId), { timeout: 10000 }).toContain('dispatched')
    await expect.poll(() => f.feedback(query.ingressId).find(value => value.queryFeedback?.stage === 'dispatched')?.state, { timeout: 35000 }).toBe('confirmed')
    const before = f.feedback(query.ingressId)
    expect(before.find(value => value.queryFeedback?.stage === 'received')?.state).toBe('unknown')
    expect(f.remote.created.filter(value => value.reaction_type.emoji_type === 'OneSecond')).toHaveLength(1)
    releaseAck()
    await expect.poll(() => f.reactions.map(value => value.reaction_type.emoji_type), { timeout: 5000 }).toEqual(['Get'])
    const after = f.feedback(query.ingressId)
    expect(after.find(value => value.queryFeedback?.stage === 'received')?.state).toBe('confirmed')
    expect(after.find(value => value.queryFeedback?.stage === 'dispatched')).toEqual(before.find(value => value.queryFeedback?.stage === 'dispatched'))
    expect(f.remote.created.filter(value => value.reaction_type.emoji_type === 'OneSecond')).toHaveLength(1)
    expect(f.submission).toHaveBeenCalledOnce()
    evidence('late-ack', { before, after, calls: f.remote.calls, active: f.reactions })
  } finally { releaseInput(); releaseAck() }
}, 45000)

it.each(['unknown', 'not-applied'] as const)('%s new-stage effect leaves the prior confirmed marker and healthy reply capability intact', async state => {
  const f = await fixture(false, call => {
    if (call.method === 'POST' && JSON.parse(call.body).reaction_type.emoji_type === 'Get')
      return { status: 200, body: { code: state === 'unknown' ? 0 : 231002, data: {} } }
    if (call.method === 'GET' && call.query.reaction_type === 'Get')
      return { status: 200, body: { code: 0, data: { items: [], has_more: false } } }
  }); f.setOffline()
  await f.wire.post(f.message(state)); const query = await f.claimed(state)
  await expect.poll(() => f.feedback(query.ingressId).find(value => value.queryFeedback?.stage === 'received')?.state).toBe('confirmed')
  const waiting = f.feedback(query.ingressId).find(value => value.queryFeedback?.stage === 'received')!
  await f.waiting(query.ingressId); f.restore()
  await expect.poll(() => f.feedback(query.ingressId).find(value => value.queryFeedback?.stage === 'dispatched')?.state).toBe(state)
  expect(f.reactions.some(value => value.reaction_id === waiting.mapping!.reactionId)).toBe(true)
  expect(f.remote.calls.some(call => call.method === 'DELETE' && call.path.endsWith('/' + waiting.mapping!.reactionId))).toBe(false)
  await f.reply(query.input!.agentSessionId, 'body-after-stage-failure', 'Healthy body remains usable')
  await expect.poll(() => f.outbox().list(f.binding(query.ingressId), 100).some(value => value.payload.kind === 'speech' && value.state === 'confirmed')).toBe(true)
  evidence('new-stage-' + state, { stages: f.feedback(query.ingressId), active: f.reactions, calls: f.remote.calls })
}, 20000)

it('default Mote shares one waiting marker across receipt and queuing, then shows delivery without implying processing', async () => {
  const f = await fixture(); f.setOffline()
  expect(await f.wire.post(f.message('queue'))).toBe(202)
  const query = await f.claimed('queue'), bound = f.binding(query.ingressId)
  await expect.poll(() => f.stages(query.ingressId), { timeout: 5000 }).toContain('received')
  await f.waiting(query.ingressId)
  const original = await f.services.ingress!.inspect({ ingressId: query.ingressId })
  expect(original.inputReceipt).toMatchObject({ status: 'waiting', persistence: 'confirmed' })
  expect(f.pending(query.ingressId)).toHaveLength(1)
  await f.waiting(query.ingressId); f.restore()
  await expect.poll(() => f.stages(query.ingressId), { timeout: 10000 }).toContain('dispatched')
  await expect.poll(() => f.feedback(query.ingressId).every(value => ['confirmed', 'superseded'].includes(value.state)), { timeout: 10000 }).toBe(true)
  expect(f.stages(query.ingressId)).toEqual(['received', 'dispatched'])
  await expect.poll(() => f.reactions.map(value => value.reaction_type.emoji_type)).toEqual(['Get'])
  expect(f.reactions.every(value => decodeURIComponent(value.path) === '/open-apis/im/v1/messages/message/queue/reactions')).toBe(true)
  expect(f.pending(query.ingressId)).toEqual([])
  const listed = await f.cli(['connection', 'delivery', 'ls', '--connection', bound.connectionId, '--binding', bound.bindingId, '--binding-revision', String(bound.revision)])
  expect(listed.deliveries.filter((value: any) => value.queryFeedback && value.effect === 'upsert').map((value: any) => value.queryFeedback.stage)).toEqual(['received', 'dispatched'])
  const delivery = f.feedback(query.ingressId).at(-1)!
  const inspected = await f.cli(['connection', 'delivery', 'inspect', '--operation-id', delivery.operationId])
  expect(inspected.delivery.queryFeedback.stage).toBe('dispatched')
  for (const privateField of ['queryPending', 'queryTurn', 'queryCompletion', 'cursor', 'throughSequence', query.body]) expect(JSON.stringify(inspected)).not.toContain(privateField)
  const read = vi.spyOn(f.services.ingress!, 'inspect'), changes = vi.spyOn(f.client, 'readAgentInputChanges')
  await f.idle(query.ingressId)
  read.mockClear(); changes.mockClear()
  for (let n = 0; n < 4; n++) f.services.publication!.refresh(true)
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(read).not.toHaveBeenCalled(); expect(changes).not.toHaveBeenCalled()

}, 90000)

it('cold publication recovery rearms an explicitly retired query after original Core cancels/rejoins and dispatches entirely offline', async () => {
  const f = await fixture(); f.setOffline()
  await f.wire.post(f.message('offline')); const query = await f.claimed('offline')
  await expect.poll(() => f.stages(query.ingressId)).toContain('received')
  await f.waiting(query.ingressId)
  const input = (await f.services.ingress!.inspect({ ingressId: query.ingressId })).inputReceipt!
  await f.client.stopAgentInputWaiting({ ref: input.ref, cancelOperationId: 'stop-original-generation' })
  await expect.poll(() => f.pending(query.ingressId)).toEqual([])
  const cut = f.outbox().queryInputPosition(f.binding(query.ingressId))
  expect(cut?.after).toBeDefined()
  f.services.publication!.close()
  const next = await f.client.rejoinAgentInputWaiting({ ref: input.ref }, f.submission.mock.calls[0]![1])
  expect(next.ref.waitGeneration).toBe(2)
  await f.waiting(query.ingressId); f.restore()
  await expect.poll(async () => (await f.client.inspectAgentInput({ key: input.key }))?.status).toBe('terminal-confirmed')
  expect(f.stages(query.ingressId)).toEqual(['received'])
  await f.restart()
  try { await expect.poll(() => f.stages(query.ingressId), { timeout: 5000 }).toContain('dispatched') }
  catch (error) {
    expect(f.stages(query.ingressId), 'Cold recovery must rediscover the original rejoined and delivered input').toContain('dispatched')
    throw error
  }
  expect(f.stages(query.ingressId)).toEqual(['received', 'dispatched'])
  expect(f.pending(query.ingressId)).toEqual([])
  expect(f.submission).toHaveBeenCalledOnce(); expect(f.start).toHaveBeenCalledOnce()
  expect(f.remote.created.filter(value => value.reaction_type.emoji_type === 'OneSecond')).toHaveLength(1)
  await expect.poll(() => f.reactions.filter(value => value.reaction_type.emoji_type === 'Get')).toHaveLength(1)
  expect(f.outbox().queryInputPosition(f.binding(query.ingressId))).not.toEqual(cut)
}, 30000)

it('unknown received reaction never blocks independent dispatched, and unchanged original requests are not POSTed again on reopen', async () => {
  const f = await fixture(true)
  await f.wire.post(f.message('unknown')); const query = await f.claimed('unknown')
  await expect.poll(() => f.stages(query.ingressId), { timeout: 10000 }).toContain('dispatched')
  await expect.poll(() => f.feedback(query.ingressId).every(value => ['unknown', 'superseded'].includes(value.state))).toBe(true)
  const frozen = f.feedback(query.ingressId).map(value => ({ id: value.operationId, prepared: value.prepared }))
  const calls = f.reactions.length
  await f.restart()
  await expect.poll(() => f.outbox().queryInputPosition(f.binding(query.ingressId))).not.toBeNull()
  expect(f.feedback(query.ingressId).map(value => ({ id: value.operationId, prepared: value.prepared }))).toEqual(frozen)
  expect(f.reactions).toHaveLength(calls); expect(f.submission).toHaveBeenCalledOnce()
}, 30000)

it('source changed retains the original position and work while normal reply publication and healthy input remain available', async () => {
  const f = await fixture(); f.setOffline()
  await f.wire.post(f.message('source')); const query = await f.claimed('source')
  await expect.poll(() => f.stages(query.ingressId)).toContain('received')
  await f.waiting(query.ingressId)
  let cut = f.outbox().queryInputPosition(f.binding(query.ingressId))
  const failed = vi.spyOn(f.client, 'readAgentInputChanges').mockImplementation(async () => {
    cut = f.outbox().queryInputPosition(f.binding(query.ingressId))
    throw new AgentMuxError('Controlled original source changed', 'AGENT_INPUT_CHANGE_SOURCE_CHANGED')
  })
  f.services.publication!.refresh()
  await expect.poll(() => f.services.publication!.observation(f.binding(query.ingressId).bindingId, 1).state).toBe('unavailable')
  expect(f.outbox().queryInputPosition(f.binding(query.ingressId))).toEqual(cut)
  expect(f.pending(query.ingressId)).toHaveLength(1)
  await f.reply(query.input!.agentSessionId, 'independent-reply', 'Original reply remains available')
  await expect.poll(() => f.outbox().list(f.binding(query.ingressId)).some(value => value.payload.kind === 'speech' && value.state === 'confirmed'), { timeout: 5000 }).toBe(true)
  failed.mockRestore(); f.restore(); f.services.publication!.refresh()
  await expect.poll(() => f.stages(query.ingressId), { timeout: 10000 }).toContain('dispatched')
}, 30000)

it('multi-page cold recovery atomically preserves the original cursor and pending anchor across registration and effect failures', async () => {
  const f = await fixture(); f.setOffline(); await f.wire.post(f.message('atomic')); const query = await f.claimed('atomic'), binding = f.binding(query.ingressId)
  await expect.poll(() => f.stages(query.ingressId), { timeout: 5000 }).toContain('received')
  await f.waiting(query.ingressId)
  const input = (await f.services.ingress!.inspect({ ingressId: query.ingressId })).inputReceipt!
  await f.client.stopAgentInputWaiting({ ref: input.ref, cancelOperationId: 'retire-original-wait' })
  await expect.poll(() => f.pending(query.ingressId)).toEqual([])
  f.services.publication!.close(); const before = f.outbox().queryInputPosition(binding)
  // Unrelated prompt keys exercise multiple pages of the original journal; none
  // may become an external query or require an ingress point read.
  for (let index = 0; index < 28; index++) {
    const receipt = await f.client.submitAgentPrompt({ agentSessionId: binding.agentSessionId, expectedRun: input.key.expectedRun,
      operationId: 'unrelated-prompt-' + index, admissionIntent: { kind: 'manual-actor' }, prompt: 'Unrelated original prompt', authorHuman: true, execution: 'immediate' })
    if (!receipt) throw Error('Original prompt receipt is missing')
    await f.client.stopAgentInputWaiting({ ref: receipt.ref, cancelOperationId: 'stop-unrelated-' + index })
  }
  await f.client.rejoinAgentInputWaiting({ ref: input.ref }, f.submission.mock.calls[0]![1]); f.restore()
  await expect.poll(async () => (await f.client.inspectAgentInput({ key: input.key }))?.status).toBe('terminal-confirmed')
  // These are storage failure points, not substitute journal/receipt authorities.
  const db = f.services.database!
  db.exec(`CREATE TRIGGER fail_query_registration BEFORE UPDATE OF operation_json ON connector_publication_operation
    WHEN json_extract(NEW.operation_json,'$.queryPending')=1 AND json_extract(OLD.operation_json,'$.queryPending') IS NULL
    BEGIN SELECT RAISE(ABORT,'controlled registration failure'); END`)
  const changes = vi.spyOn(f.client, 'readAgentInputChanges')
  await f.restart()
  await expect.poll(() => f.services.publication!.observation(binding.bindingId, 1).state).toBe('unavailable')
  await f.idle(query.ingressId)
  const failedPosition = f.outbox().queryInputPosition(binding)
  expect(failedPosition).not.toEqual({ after: (await f.client.readAgentInputChanges({ agentSessionId: binding.agentSessionId })).checkpoint })
  expect(f.pending(query.ingressId)).toEqual([]); expect(f.stages(query.ingressId)).not.toContain('dispatched')
  // A successful earlier page may have advanced a durable frozen page cursor.
  expect(failedPosition?.cursor?.throughSequence ?? failedPosition?.after?.sequence).toBeGreaterThanOrEqual(before!.after!.sequence)
  const reopened = f.services.database!; reopened.exec('DROP TRIGGER fail_query_registration')
  reopened.exec(`CREATE TRIGGER fail_query_effect BEFORE INSERT ON connector_publication_operation
    WHEN json_extract(NEW.operation_json,'$.queryFeedback.stage')='dispatched'
    BEGIN SELECT RAISE(ABORT,'controlled effect failure'); END`)
  f.services.publication!.refresh()
  await expect.poll(() => f.pending(query.ingressId)).toHaveLength(1)
  await expect.poll(() => f.services.publication!.observation(binding.bindingId, 1).state).toBe('unavailable')
  await f.idle(query.ingressId)
  expect(f.stages(query.ingressId)).not.toContain('dispatched')
  const committed = f.outbox().queryInputPosition(binding); expect(committed?.after).toBeDefined()
  reopened.exec('DROP TRIGGER fail_query_effect')
  const inspect = vi.spyOn(f.services.ingress!, 'inspect'); f.services.publication!.refresh()
  await expect.poll(() => f.stages(query.ingressId), { timeout: 10000 }).toContain('dispatched')
  expect(inspect.mock.calls.map(([value]) => value)).toEqual([{ ingressId: query.ingressId }])
  expect(f.pending(query.ingressId)).toEqual([]); expect(f.stages(query.ingressId)).toEqual(['received', 'dispatched'])
  expect(changes.mock.calls.some(([value]) => value.cursor && value.limit === 25)).toBe(true)
  expect(changes.mock.calls.every(([value]) => value.limit === undefined || value.limit === 25)).toBe(true)
  const plan = reopened.prepare("EXPLAIN QUERY PLAN SELECT ordinal FROM connector_publication_operation WHERE binding_id=? AND binding_revision=? AND json_extract(operation_json,'$.queryPending')=1 AND ordinal>? AND ordinal<=? ORDER BY ordinal LIMIT 25").all(binding.bindingId, binding.revision, 0, 100000)
  expect(JSON.stringify(plan)).toContain('connector_publication_query_pending'); expect(f.submission).toHaveBeenCalledOnce()
}, 45000)

it('original direct generations keep separate received anchors and neither ordinary replies nor a newer private chat prove native adoption', async () => {
  const f = await moteChatJourneyFixture(0, 1, 'headless', false, 'grok', call => {
    if (!call.path.endsWith('/reactions')) return
    return { status: 200, body: { code: 0, data: call.method === 'POST' ? { reaction_id: 'native-reaction', reaction_type: JSON.parse(call.body).reaction_type } : { items: [], has_more: false } } }
  })
  const generation = (id: string) => { const store = new MoteChatStore(f.services.database!); return store.generation(store.admissionByIngress(id)!.generationId)! }
  const stages = (id: string) => f.services.publication!.store.list(generation(id).binding!, 100).filter(value => value.queryFeedback?.ingressId === id && value.effect === 'upsert').map(value => value.queryFeedback!.stage)
  await f.wire.post(f.message('older-generation')); const older = await f.claimed('older-generation')
  await expect.poll(() => stages(older.ingressId), { timeout: 5000 }).toContain('dispatched')
  await f.wire.post(f.message('newer-generation')); const newer = await f.claimed('newer-generation')
  await expect.poll(() => stages(newer.ingressId), { timeout: 5000 }).toContain('dispatched')
  expect(older.input!.agentSessionId).not.toBe(newer.input!.agentSessionId)
  expect(older.input!.admissionIntent).toEqual({ kind: 'session-conversation', expectedRun: older.input!.expectedRun })
  expect(newer.input!.admissionIntent).toEqual({ kind: 'session-conversation', expectedRun: newer.input!.expectedRun })
  await f.reply(older.input!.agentSessionId, 'original-reply', 'The old conversation continues independently')
  f.services.publication!.refresh()
  await expect.poll(() => f.services.publication!.store.list(generation(older.ingressId).binding!, 100).some(value => value.payload.kind === 'speech' && value.state === 'confirmed'), { timeout: 5000 }).toBe(true)
  for (const query of [older, newer]) {
    expect(stages(query.ingressId)).toEqual(['received', 'dispatched'])
    expect(f.services.publication!.store.queryReceived(generation(query.ingressId).binding!, query.ingressId)).toMatchObject({ reference: { agentSessionId: query.input!.agentSessionId }, queryFeedback: { ingressId: query.ingressId, messageId: query.externalMessageId } })
  }
  expect(f.submission).toHaveBeenCalledTimes(2); expect(f.start).toHaveBeenCalledTimes(2)
}, 20000)

it('a hung optional changes read retains one slot while healthy input and original reply delivery continue', async () => {
  const f = await fixture()
  const status = (f.inner.kernel.status as (id: string) => Promise<ReturnType<typeof f.run>>).bind(f.inner.kernel)
  // Retain the original Run identity while the controlled Runtime reports the
  // ordered byte cursor advanced by its real input port across both messages.
  f.inner.kernel.status = async (id: string) => ({ ...await status(id), acceptedInputBytes: f.run(id).acceptedInputBytes })
  await f.wire.post(f.message('before-hang')); const original = await f.claimed('before-hang')
  await expect.poll(() => f.stages(original.ingressId), { timeout: 5000 }).toContain('dispatched')
  await f.idle(original.ingressId)
  const read = f.client.readAgentInputChanges.bind(f.client); let release!: () => void, secondId = ''
  const held = new Promise<void>(resolve => { release = resolve })
  const blocked = vi.spyOn(f.client, 'readAgentInputChanges').mockImplementation(async input => { await held; return await read(input) })
  try {
    f.services.publication!.refresh(); await expect.poll(() => blocked.mock.calls.length, { timeout: 5000 }).toBe(1)
    for (let index = 0; index < 5; index++) f.services.publication!.refresh()
    await f.wire.post(f.message('during-hang')); const second = await f.claimed('during-hang'); secondId = second.ingressId
    try { await expect.poll(async () => (await f.services.ingress!.inspect({ ingressId: second.ingressId })).inputReceipt?.status, { timeout: 5000 }).toBe('terminal-confirmed') }
    finally { evidence('hung-reader-independent-input', { input: await f.services.ingress!.inspect({ ingressId: second.ingressId }), submissionErrors: f.submissionErrors }) }
    await f.reply(original.input!.agentSessionId, 'reply-during-hang', 'Text still reaches the original conversation')
    await expect.poll(() => f.outbox().list(f.binding(original.ingressId), 100).some(value => value.payload.kind === 'speech' && value.state === 'confirmed'), { timeout: 5000 }).toBe(true)
    expect(blocked).toHaveBeenCalledOnce(); expect(f.submission).toHaveBeenCalledTimes(2)
  } finally { release() }
  await expect.poll(() => f.stages(secondId), { timeout: 5000 }).toContain('dispatched')
}, 20000)
