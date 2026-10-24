import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as core from '@agentmux/core'
import { moteChatDiagnosisKey } from '@agentmux/core/mote-chat'
import type { ConnectionDelivery, ConnectionDeliveryResultMap } from '@agentmux/core/connections'
import { MoteChatStore } from '../src/mote-chat-store.js'
import { moteChatJourneyFixture as fixture } from './fixtures/mote-chat-journey.js'

it('reads frozen runtime and one bounded generation publication window through the real CLI without exposing private history', async () => {
  const f = await fixture(1, 60_000, 'headless')
  const status = f.inner.kernel.status as (id: string) => Promise<ReturnType<typeof f.run>>
  f.inner.kernel.status = async (id: string) => ({ ...await status(id), acceptedInputBytes: f.run(id).acceptedInputBytes })
  expect(await f.wire.post(f.message('first'))).toBe(202); const first = await f.claimed('first')
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  expect(await f.wire.post(f.message('second'))).toBe(202); const second = await f.claimed('second')
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledTimes(2))
  const store = new MoteChatStore(f.services.database!), admission = store.admissionByIngress(first.ingressId)!, generation = store.generation(admission.generationId)!, binding = generation.binding!
  expect(store.admissionByIngress(second.ingressId)?.generationId).toBe(admission.generationId)
  const originalList = f.services.publication!.list.bind(f.services.publication!)
  let mode: 'original' | 'source-failure' | 'effects' | 'unavailable' = 'original'
  const list = vi.spyOn(f.services.publication!, 'list').mockImplementation(async input => {
    expect(input).toEqual({ connectionId: binding.connectionId, bindingId: binding.bindingId, bindingRevision: binding.revision, order: 'newest', limit: 5 })
    const original = await originalList(input)
    if (mode === 'original') return original
    if (mode === 'unavailable') throw Error('PRIVATE_PUBLICATION_EXCEPTION')
    if (mode === 'source-failure') return { ...original, observation: { state: 'unavailable', reason: 'source-unconfirmed' },
      sourceObservation: { state: 'unavailable', reason: 'source-unconfirmed', code: 'AGENT_SESSION_HISTORY_LOCATOR_UNAVAILABLE', codeRecorded: true, checkpointKey: 'a'.repeat(64) },
      coverage: { state: 'incomplete', gaps: [{ gapId: 'PRIVATE_GAP', reason: 'source-gap', code: 'PRIVATE_NATIVE_CAUSE' }], nextContent: 'PRIVATE_CURSOR', origins: [] } }
    const base: ConnectionDelivery = { operationId: 'PRIVATE_OPERATION', projectionId: 'PRIVATE_PROJECTION', sourceRevision: 'b'.repeat(64), bindingId: binding.bindingId, bindingRevision: binding.revision,
      reference: { hostId: generation.generation.executionHostId, agentSessionId: generation.generation.agentSessionId, source: { kind: 'native', providerId: 'claude', nativeSessionId: 'PRIVATE_NATIVE', recordId: 'PRIVATE_RECORD' } },
      target: { connectionId: binding.connectionId, application: binding.application, externalConversationId: binding.externalConversationId }, effect: 'upsert', fragment: { ordinal: 0, count: 1 },
      state: 'unknown', reason: 'effect-unconfirmed', receipt: { state: 'unknown', reason: 'effect-unconfirmed' } }
    const { reason: _reason, ...confirmed } = base
    const page: ConnectionDeliveryResultMap['connection.delivery.ls'] = { ...original, deliveries: [base,
      { ...confirmed, operationId: 'PRIVATE_CONFIRMED', state: 'confirmed', mapping: { messageId: 'PRIVATE_PLATFORM_ID' }, receipt: { state: 'confirmed', mapping: { messageId: 'PRIVATE_PLATFORM_ID' } } },
      { ...base, operationId: 'PRIVATE_FEEDBACK', reference: { ...base.reference, source: { kind: 'ingress', ingressId: first.ingressId } }, queryFeedback: { stage: 'received', ingressId: first.ingressId, messageId: first.externalMessageId } }], next: null,
      effectObservation: { state: 'unknown', reason: 'effect-unconfirmed' } }
    return page
  })
  const runtime = vi.spyOn(f.services.ingress!, 'inspectInputRuntime'), rejoin = vi.spyOn(f.client, 'rejoinAgentInputWaiting')
  const inspect = f.services.ingress!.inspect.bind(f.services.ingress!)
  const inspectSpy = vi.spyOn(f.services.ingress!, 'inspect')
  const report = await f.cli('diagnose', { target: f.target }, f.credentials(0))
  expect(list).toHaveBeenCalledOnce(); expect(runtime).toHaveBeenCalledOnce()
  expect(report.incoming.rows).toHaveLength(2)
  for (const row of report.incoming.rows) expect(row.input).toMatchObject({ status: 'terminal-confirmed', runtime: { target: 'original', state: 'running', exitCode: null } })
  expect(report.publications).toHaveLength(1)
  expect(report.publications[0]).toMatchObject({ intakeKeys: report.incoming.rows.map((row: { key: string }) => row.key), reading: 'observed', effects: [], more: false })
  mode = 'source-failure'
  const failed = await f.sdk.call('space.mote.chat.diagnose', { target: f.target })
  expect(failed.publications[0]).toMatchObject({ reading: 'observed', sourceObservation: { state: 'unavailable', code: 'AGENT_SESSION_HISTORY_LOCATOR_UNAVAILABLE' },
    coverage: { state: 'incomplete', more: true, gaps: [{ reason: 'source-gap', code: null, codeRecorded: true }] }, effects: [] })
  mode = 'effects'
  const effects = await f.cli('diagnose', { target: f.target }, f.credentials(0))
  expect(effects.publications[0].effects).toEqual([
    { kind: 'conversation', effect: 'upsert', state: 'unknown', receipt: { state: 'unknown', reason: 'effect-unconfirmed' }, resourceUpload: null },
    { kind: 'conversation', effect: 'upsert', state: 'confirmed', receipt: { state: 'confirmed', reason: null }, resourceUpload: null },
    { kind: 'query-feedback', effect: 'upsert', state: 'unknown', receipt: { state: 'unknown', reason: 'effect-unconfirmed' }, resourceUpload: null }
  ])
  mode = 'unavailable'
  const unavailable = await f.sdk.call('space.mote.chat.diagnose', { target: f.target })
  expect(unavailable.publications[0]).toMatchObject({ reading: 'unavailable', effects: null, observation: null, sourceObservation: null })
  expect(unavailable.incoming!.rows[0]!.input.status).toBe('terminal-confirmed')
  inspectSpy.mockImplementation(async input => { const original = await inspect(input); return { ...original, ...(original.inputReceipt ? { inputReceipt: { ...original.inputReceipt, status: 'admitted' as const } } : {}) } })
  runtime.mockClear()
  const admitted = await f.sdk.call('space.mote.chat.diagnose', { target: f.target })
  expect(admitted.incoming!.rows[0]!.input).toMatchObject({ status: 'admitted', runtime: { target: 'original', state: 'running' } }); expect(runtime).toHaveBeenCalledOnce()
  const serialized = JSON.stringify([report, failed, effects, unavailable, admitted])
  for (const value of [f.root, f.creator.userId, first.body, first.ingressId, first.externalMessageId, first.externalConversationId, binding.bindingId,
    generation.generation.generationId, generation.generation.agentSessionId, generation.generation.createOperationId, first.input!.expectedRun.runId,
    'PRIVATE_OPERATION', 'PRIVATE_PROJECTION', 'PRIVATE_CONFIRMED', 'PRIVATE_FEEDBACK', 'PRIVATE_PLATFORM_ID', 'PRIVATE_GAP', 'PRIVATE_CURSOR', 'PRIVATE_NATIVE_CAUSE', 'PRIVATE_NATIVE', 'PRIVATE_RECORD', 'PRIVATE_PUBLICATION_EXCEPTION']) expect(serialized).not.toContain(value)
  store.saveGeneration({ ...generation, generation: { ...generation.generation, target: { ...generation.generation.target, zoneId: 'other-private-zone' } } })
  list.mockClear(); runtime.mockClear()
  const other = await f.sdk.call('space.mote.chat.diagnose', { target: f.target })
  expect(other.publications).toEqual([]); expect(other.incoming!.rows.every(row => row.preparation === 'other-route' && row.input.status === null)).toBe(true)
  expect(list).not.toHaveBeenCalled(); expect(runtime).not.toHaveBeenCalled(); expect(rejoin).not.toHaveBeenCalled()
  expect(f.inner.kernel.input).toHaveBeenCalledTimes(2); expect(f.start).toHaveBeenCalledOnce(); expect(f.wire.effects).toHaveLength(0)
}, 20_000)

it('diagnoses retained private preparation through authenticated CLI without granting management and recovers the same admission', async () => {
  const f = await fixture(1, 60_000, 'headless')
  expect(await f.wire.post(f.message('owner'))).toBe(202)
  await f.claimed('owner')
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  await writeFile(join(f.topic.physicalDirectoryPath!, 'MOTE.md'), '---\nversion: 1\ndefaults:\n  executorId: unavailable-executor\n---\n')
  expect(await f.wire.post(f.message('retained-guest', f.guest))).toBe(202)
  await vi.waitFor(async () => expect((await f.records()).find(r => r.externalMessageId === 'message/retained-guest'))
    .toMatchObject({ state: 'received', code: 'MOTE_CHAT_EXECUTOR_UNAVAILABLE' }))
  const record = (await f.records()).find(r => r.externalMessageId === 'message/retained-guest')!
  const store = new MoteChatStore(f.services.database!)
  const admission = store.admissionByIngress(record.ingressId)!, generation = store.generation(admission.generationId)!
  const report = await f.cli('diagnose', { target: f.target }, f.credentials(0))
  expect(report).toMatchObject({ targetKey: moteChatDiagnosisKey(f.target), limit: 5,
    configuration: { enabled: true, revision: 1, connection: { connectionId: 'original-bot' } },
    readiness: { state: 'unavailable', code: 'MOTE_CHAT_EXECUTOR_UNAVAILABLE' }, issues: [],
    incoming: { more: false, rows: [
      { key: moteChatDiagnosisKey(f.target, record.ingressId), state: 'received', code: 'MOTE_CHAT_EXECUTOR_UNAVAILABLE', preparation: 'reserved', input: { status: null, observation: 'not-started' } },
      { state: 'claimed', preparation: 'ready', input: { observation: 'observed' } }
    ] } })
  const serialized = JSON.stringify(report)
  for (const secret of [f.root, f.creator.userId, f.guest.userId, f.message('retained-guest', f.guest).text,
    record.ingressId, record.externalMessageId, record.externalConversationId, generation.generation.agentSessionId, generation.generation.createOperationId]) expect(serialized).not.toContain(secret)
  const agent = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.root, 'public.sock') }, credentials: f.credentials(0) })
  try {
    await expect(agent.call('space.mote.chat.inspect', { target: f.target })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    await expect(agent.call('space.mote.chat.audience', { target: f.target })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    await expect(agent.call('space.mote.chat.history', { target: f.target, actor: f.guest })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    const changed = await agent.call('space.mote.chat.diagnose', { target: { ...f.target, zoneId: 'another-zone' } })
    expect(changed).toMatchObject({ configuration: null, incoming: null, issues: ['target-changed'] })
  } finally { await agent.dispose() }
  expect(f.start).toHaveBeenCalledOnce()
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  expect(f.wire.effects).toHaveLength(0)
  await writeFile(join(f.topic.physicalDirectoryPath!, 'MOTE.md'), '---\nversion: 1\ndefaults:\n  executorId: saved-chat\n---\n')
  await f.restart()
  const recovered = await f.claimed('retained-guest')
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledTimes(2))
  expect(recovered.ingressId).toBe(record.ingressId)
  expect(recovered.input?.agentSessionId).toBe(generation.generation.agentSessionId)
  expect(recovered.code).toBeUndefined()
  expect(f.start).toHaveBeenCalledTimes(2)
  expect((await f.services.moteChat!.audience({ target: f.target })).people.find(person => !person.creator)).toMatchObject({ used: 1, remaining: 0 })
  const after = await f.sdk.call('space.mote.chat.diagnose', { target: f.target })
  expect(after.incoming!.rows[0]).toMatchObject({ key: report.incoming.rows[0].key, code: null, codeRecorded: false, preparation: 'ready', state: 'claimed' })
}, 20_000)

it('distinguishes an unconfirmed creation response from present readiness and preserves one dispatched creation', async () => {
  const f = await fixture(1, 60_000, 'headless')
  const original = f.client.createHostAgentWithDelivery.bind(f.client)
  const create = vi.spyOn(f.client, 'createHostAgentWithDelivery').mockImplementationOnce(async (...args) => {
    await original(...args)
    throw new core.AgentMuxError('private exception detail must not escape', 'MOTE_CHAT_CONTEXT_UNCONFIRMED')
  })
  expect(await f.wire.post(f.message('creation-wait'))).toBe(202)
  await vi.waitFor(async () => expect((await f.records())[0]).toMatchObject({ state: 'received', code: 'MOTE_CHAT_CONTEXT_UNCONFIRMED' }))
  const before = await f.sdk.call('space.mote.chat.diagnose', { target: f.target })
  expect(before).toMatchObject({ readiness: { state: 'ready', code: null }, incoming: { rows: [
    { preparation: 'creation-dispatched', code: 'MOTE_CHAT_CONTEXT_UNCONFIRMED', input: { observation: 'not-started' } }
  ] } })
  expect(before.publications).toHaveLength(1); expect(before.publications[0]).toMatchObject({ reading: 'not-started', effects: null })
  expect(JSON.stringify(before)).not.toContain('private exception')
  expect(create).toHaveBeenCalledOnce()
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  await f.restart()
  await f.claimed('creation-wait')
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  expect(create).toHaveBeenCalledOnce()
  expect((await f.sdk.call('space.mote.chat.diagnose', { target: f.target })).incoming!.rows[0])
    .toMatchObject({ key: before.incoming!.rows[0]!.key, code: null, state: 'claimed', preparation: 'ready' })
}, 15_000)

it('bounds direct-intake diagnosis independently of group traffic and keeps unknown preparation details private', async () => {
  const f = await fixture(0, 60_000, 'headless')
  f.prepare.mockRejectedValue(new core.AgentMuxError('secret body and file path', 'PRIVATE_ARBITRARY_ERROR'))
  expect(await f.wire.post(f.message('opaque'))).toBe(202)
  await vi.waitFor(async () => expect((await f.records())[0]).toMatchObject({ code: 'INGRESS_PREPARATION_UNAVAILABLE' }))
  const opaque = await f.sdk.call('space.mote.chat.diagnose', { target: f.target })
  expect(opaque.incoming!.rows[0]).toMatchObject({ state: 'received', code: 'INGRESS_PREPARATION_UNAVAILABLE', preparation: 'reserved' })
  expect(JSON.stringify(opaque)).not.toMatch(/PRIVATE_ARBITRARY_ERROR|secret body|file path/u)
  for (let index = 0; index < 7; index++) {
    expect(await f.wire.post(f.message(`guest-${index}`, f.guest))).toBe(202)
    expect(await f.wire.post({ ...f.message(`group-${index}`), nativeKind: 'group', roomKey: 'unrelated-group' })).toBe(202)
  }
  await vi.waitFor(async () => expect((await f.records()).filter(r => r.code === 'MOTE_CHAT_QUOTA_EXHAUSTED')).toHaveLength(7))
  const report = await f.sdk.call('space.mote.chat.diagnose', { target: f.target })
  expect(report.incoming?.more).toBe(true)
  expect(report.incoming!.rows).toHaveLength(5)
  expect(report.incoming!.rows.every(row => row.code === 'MOTE_CHAT_QUOTA_EXHAUSTED' && row.preparation === 'not-admitted')).toBe(true)
  expect(f.start).not.toHaveBeenCalled()
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('reports saved chat and service switches separately from startup readiness without starting work', async () => {
  const f = await fixture(0, 60_000, 'headless')
  const initial = await f.sdk.call('space.mote.chat.inspect', { target: f.target })
  const configuration = initial.configuration!
  await f.sdk.call('space.mote.chat.configure', { operationId: 'pause-original-chat', target: f.target,
    expectedRevision: configuration.revision, expectedConnectionRevision: 1, values: { ...configuration.values, enabled: false } })
  const policy = await f.sdk.call('connection.service.get', {})
  await f.sdk.call('connection.service.configure', { operationId: 'pause-original-service', expectedRevision: policy.revision, service: { enabled: false } })
  const report = await f.cli('diagnose', { target: f.target })
  expect(report).toMatchObject({ configuration: { enabled: false, revision: 2 }, service: { enabled: false },
    readiness: { state: 'ready', code: null }, incoming: { rows: [], more: false }, issues: [] })
  expect(f.prepare).not.toHaveBeenCalled()
  expect(f.start).not.toHaveBeenCalled()
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect(f.wire.effects).toHaveLength(0)
})
