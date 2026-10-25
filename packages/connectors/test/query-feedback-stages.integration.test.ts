import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { AgentMuxError } from '@agentmux/core'
import { MoteChatStore } from '../src/mote-chat-store.js'
import { moteChatJourneyFixture } from './fixtures/mote-chat-journey.js'
import { feishuConfig } from './fixtures/feishu.js'
import { runSourceObjectCli } from '../../core/test/helpers/source-object-cli.js'
import { objectCliEnvironment } from '../../core/test/helpers/object-cli-rpc.js'

async function fixture(unknown = false) {
  const reactions: Array<{ path: string; reaction_id: string; operator: { operator_type: string; operator_id: string }; reaction_type: { emoji_type: string } }> = []
  const f = await moteChatJourneyFixture(0, 60000, 'headless', false, 'grok', call => {
    if (!call.path.endsWith('/reactions')) return
    if (call.method === 'POST') {
      const value = { path: call.path, reaction_id: 'reaction-' + (reactions.length + 1), operator: { operator_type: 'app', operator_id: feishuConfig.application.appId }, reaction_type: JSON.parse(call.body).reaction_type }
      reactions.push(value)
      return { status: 200, body: { code: 0, data: unknown ? {} : value } }
    }
    return { status: 200, body: { code: 0, data: { items: unknown ? [] : reactions.filter(value => value.path === call.path && value.reaction_type.emoji_type === call.query.reaction_type), has_more: false } } }
  })
  const binding = (id: string) => { const store = new MoteChatStore(f.services.database!); return store.generation(store.admissionByIngress(id)!.generationId)!.binding! }
  const outbox = () => f.services.publication!.store
  const feedback = (id: string) => outbox().list(binding(id), 100).filter(value => value.queryFeedback?.ingressId === id)
  const stages = (id: string) => feedback(id).map(value => value.queryFeedback!.stage)
  const pending = (id: string) => outbox().queryInputPending(binding(id), 0).rows
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
  return { ...f, get services() { return f.services }, get sdk() { return f.sdk }, reactions, binding, outbox, feedback, stages, pending, idle, restore,
    setOffline() { offline = true },
    cli: async (args: string[], input?: unknown) => {
      const result = await runSourceObjectCli(['--endpoint', 'unix:' + join(f.root, 'public.sock'), ...args], objectCliEnvironment(f.root,
        process.env.AGENTMUX_TEST_QUERY_CLI_LOADED ? { AGENTMUX_RESUMED_INBOX_CLI_LOADED: process.env.AGENTMUX_TEST_QUERY_CLI_LOADED } : {}), input ? JSON.stringify(input) : '', 30000,
        new URL('../../core/test/fixtures/a2a-resumed-inbox/source-loader.mjs', import.meta.url))
      expect(result.code, result.stdout + result.stderr).toBe(0); return JSON.parse(result.stdout).result
    }
  }
}

it('default Mote shows independently received, actually queued and dispatched via real Core and native SDK; native unknown stays quiet', async () => {
  const f = await fixture(); f.setOffline()
  expect(await f.wire.post(f.message('queue'))).toBe(202)
  const query = await f.claimed('queue'), bound = f.binding(query.ingressId)
  await expect.poll(() => f.stages(query.ingressId), { timeout: 5000 }).toContain('queued')
  const original = await f.services.ingress!.inspect({ ingressId: query.ingressId })
  expect(original.inputReceipt).toMatchObject({ status: 'waiting', persistence: 'confirmed' })
  expect(f.pending(query.ingressId)).toHaveLength(1)
  f.restore()
  await expect.poll(() => f.stages(query.ingressId), { timeout: 10000 }).toContain('dispatched')
  await expect.poll(() => f.feedback(query.ingressId).every(value => value.state === 'confirmed'), { timeout: 10000 }).toBe(true)
  expect(f.stages(query.ingressId)).toEqual(['received', 'queued', 'dispatched'])
  expect(f.reactions.map(value => value.reaction_type.emoji_type)).toEqual(['Get', 'OneSecond', 'CheckMark'])
  expect(f.reactions.every(value => decodeURIComponent(value.path) === '/open-apis/im/v1/messages/message/queue/reactions')).toBe(true)
  expect(f.pending(query.ingressId)).toEqual([])
  const read = vi.spyOn(f.services.ingress!, 'inspect'), changes = vi.spyOn(f.client, 'readAgentInputChanges')
  await f.idle(query.ingressId)
  read.mockClear(); changes.mockClear()
  for (let n = 0; n < 4; n++) f.services.publication!.refresh(true)
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(read).not.toHaveBeenCalled(); expect(changes).not.toHaveBeenCalled()
  const listed = await f.cli(['connection', 'delivery', 'ls', '--connection', bound.connectionId, '--binding', bound.bindingId, '--binding-revision', String(bound.revision)])
  expect(listed.deliveries.filter((value: any) => value.queryFeedback).map((value: any) => value.queryFeedback.stage)).toEqual(['received', 'queued', 'dispatched'])
  const delivery = f.feedback(query.ingressId).at(-1)!
  const inspected = await f.cli(['connection', 'delivery', 'inspect', '--operation-id', delivery.operationId])
  expect(inspected.delivery.queryFeedback.stage).toBe('dispatched')
  for (const privateField of ['queryPending', 'queryTurn', 'queryCompletion', 'cursor', 'throughSequence', query.body]) expect(JSON.stringify(inspected)).not.toContain(privateField)
}, 90000)

it('cold publication recovery rearms an explicitly retired query after original Core cancels/rejoins and dispatches entirely offline', async () => {
  const f = await fixture(); f.setOffline()
  await f.wire.post(f.message('offline')); const query = await f.claimed('offline')
  await expect.poll(() => f.stages(query.ingressId)).toContain('queued')
  const input = (await f.services.ingress!.inspect({ ingressId: query.ingressId })).inputReceipt!
  await f.client.stopAgentInputWaiting({ ref: input.ref, cancelOperationId: 'stop-original-generation' })
  await expect.poll(() => f.pending(query.ingressId)).toEqual([])
  const cut = f.outbox().queryInputPosition(f.binding(query.ingressId))
  expect(cut?.after).toBeDefined()
  f.services.publication!.close()
  const next = await f.client.rejoinAgentInputWaiting({ ref: input.ref }, f.submission.mock.calls[0]![1])
  expect(next.ref.waitGeneration).toBe(2)
  f.restore()
  await expect.poll(async () => (await f.client.inspectAgentInput({ key: input.key }))?.status).toBe('terminal-confirmed')
  expect(f.stages(query.ingressId)).toEqual(['received', 'queued'])
  await f.restart()
  try { await expect.poll(() => f.stages(query.ingressId), { timeout: 5000 }).toContain('dispatched') }
  catch (error) {
    expect(f.stages(query.ingressId), 'Cold recovery must rediscover the original rejoined and delivered input').toContain('dispatched')
    throw error
  }
  expect(f.stages(query.ingressId)).toEqual(['received', 'queued', 'dispatched'])
  expect(f.pending(query.ingressId)).toEqual([])
  expect(f.submission).toHaveBeenCalledOnce(); expect(f.start).toHaveBeenCalledOnce()
  expect(f.reactions.filter(value => value.reaction_type.emoji_type === 'OneSecond')).toHaveLength(1)
  await expect.poll(() => f.reactions.filter(value => value.reaction_type.emoji_type === 'CheckMark')).toHaveLength(1)
  expect(f.outbox().queryInputPosition(f.binding(query.ingressId))).not.toEqual(cut)
}, 30000)

it('unknown received reaction never blocks independent dispatched, and unchanged original requests are not POSTed again on reopen', async () => {
  const f = await fixture(true)
  await f.wire.post(f.message('unknown')); const query = await f.claimed('unknown')
  await expect.poll(() => f.stages(query.ingressId)).toContain('dispatched')
  await expect.poll(() => f.feedback(query.ingressId).every(value => value.state === 'unknown')).toBe(true)
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
  await expect.poll(() => f.stages(query.ingressId)).toContain('queued')
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
  await expect.poll(() => f.stages(query.ingressId)).toContain('dispatched')
}, 30000)

it('multi-page cold recovery atomically preserves the original cursor and pending anchor across registration and effect failures', async () => {
  const f = await fixture(); f.setOffline(); await f.wire.post(f.message('atomic')); const query = await f.claimed('atomic'), binding = f.binding(query.ingressId)
  await expect.poll(() => f.stages(query.ingressId), { timeout: 5000 }).toContain('queued')
  const input = (await f.services.ingress!.inspect({ ingressId: query.ingressId })).inputReceipt!
  await f.client.stopAgentInputWaiting({ ref: input.ref, cancelOperationId: 'retire-original-wait' })
  await expect.poll(() => f.pending(query.ingressId)).toEqual([])
  f.services.publication!.close(); const before = f.outbox().queryInputPosition(binding)
  // Unrelated prompt keys exercise multiple pages of the original journal; none
  // may become an external query or require an ingress point read.
  for (let index = 0; index < 28; index++) {
    const receipt = await f.client.submitAgentPrompt({ agentSessionId: binding.agentSessionId, expectedRun: input.key.expectedRun,
      operationId: 'unrelated-prompt-' + index, admissionIntent: { kind: 'manual-actor' }, prompt: 'Unrelated original prompt', authorHuman: true, execution: 'immediate' })
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
  expect(f.pending(query.ingressId)).toEqual([]); expect(f.stages(query.ingressId)).toEqual(['received', 'queued', 'dispatched'])
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
  const stages = (id: string) => f.services.publication!.store.list(generation(id).binding!, 100).filter(value => value.queryFeedback?.ingressId === id).map(value => value.queryFeedback!.stage)
  await f.wire.post(f.message('older-generation')); const older = await f.claimed('older-generation')
  await expect.poll(() => stages(older.ingressId), { timeout: 5000 }).toContain('dispatched')
  await f.wire.post(f.message('newer-generation')); const newer = await f.claimed('newer-generation')
  await expect.poll(() => stages(newer.ingressId), { timeout: 5000 }).toContain('dispatched')
  expect(older.input!.agentSessionId).not.toBe(newer.input!.agentSessionId)
  expect(older.input!.admissionIntent?.kind).toBe('manual-actor'); expect(newer.input!.admissionIntent?.kind).toBe('manual-actor')
  await f.reply(older.input!.agentSessionId, 'original-reply', 'The old conversation continues independently')
  f.services.publication!.refresh()
  await expect.poll(() => f.services.publication!.store.list(generation(older.ingressId).binding!, 100).some(value => value.payload.kind === 'speech' && value.state === 'confirmed'), { timeout: 5000 }).toBe(true)
  for (const query of [older, newer]) {
    expect(stages(query.ingressId).filter(stage => stage !== 'queued')).toEqual(['received', 'dispatched'])
    expect(f.services.publication!.store.queryReceived(generation(query.ingressId).binding!, query.ingressId)).toMatchObject({ reference: { agentSessionId: query.input!.agentSessionId }, queryFeedback: { ingressId: query.ingressId, messageId: query.externalMessageId } })
  }
  expect(f.submission).toHaveBeenCalledTimes(2); expect(f.start).toHaveBeenCalledTimes(2)
}, 20000)

it('a hung optional changes read retains one slot while healthy input and original reply delivery continue', async () => {
  const f = await fixture()
  const status = f.inner.kernel.status.bind(f.inner.kernel)
  // Retain the original Run identity while the controlled Runtime reports the
  // ordered byte cursor advanced by its real input port across both messages.
  f.inner.kernel.status = async id => ({ ...await status(id), acceptedInputBytes: f.run(id).acceptedInputBytes })
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
    await expect.poll(async () => (await f.services.ingress!.inspect({ ingressId: second.ingressId })).inputReceipt?.status).toBe('terminal-confirmed')
    await f.reply(original.input!.agentSessionId, 'reply-during-hang', 'Text still reaches the original conversation')
    await expect.poll(() => f.outbox().list(f.binding(original.ingressId), 100).some(value => value.payload.kind === 'speech' && value.state === 'confirmed'), { timeout: 5000 }).toBe(true)
    expect(blocked).toHaveBeenCalledOnce(); expect(f.submission).toHaveBeenCalledTimes(2)
  } finally { release() }
  await expect.poll(() => f.stages(secondId), { timeout: 5000 }).toContain('dispatched')
}, 20000)
