import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as core from '@agentmux/core'
import { moteChatDiagnosisKey } from '@agentmux/core/mote-chat'
import { MoteChatStore } from '../src/mote-chat-store.js'
import { moteChatJourneyFixture as fixture } from './fixtures/mote-chat-journey.js'

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

it('distinguishes source preparation from present readiness and preserves one dispatched creation', async () => {
  const f = await fixture(1, 60_000, 'headless')
  const create = vi.spyOn(f.client, 'createHostAgentWithDelivery')
  const checkpoint = vi.spyOn(f.client, 'conversationCheckpoint')
  checkpoint.mockRejectedValueOnce(new core.AgentMuxError('private exception detail must not escape', 'AGENT_CONVERSATION_SOURCE_UNAVAILABLE'))
  expect(await f.wire.post(f.message('source-wait'))).toBe(202)
  await vi.waitFor(async () => expect((await f.records())[0]).toMatchObject({ state: 'received', code: 'AGENT_CONVERSATION_SOURCE_UNAVAILABLE' }))
  const before = await f.sdk.call('space.mote.chat.diagnose', { target: f.target })
  expect(before).toMatchObject({ readiness: { state: 'ready', code: null }, incoming: { rows: [
    { preparation: 'creation-dispatched', code: 'AGENT_CONVERSATION_SOURCE_UNAVAILABLE', input: { observation: 'not-started' } }
  ] } })
  expect(JSON.stringify(before)).not.toContain('private exception')
  expect(checkpoint).toHaveBeenCalledOnce()
  expect(create).toHaveBeenCalledOnce()
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  await f.restart()
  await f.claimed('source-wait')
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
