// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as core from '../../core/dist/index.js'
import { parseConnectionIngressRecord } from '../../core/dist/connections.js'
import { DurableIngressHost, type IngressAuthenticator } from '../src/durable-ingress.js'
import { ingressFixture } from './fixtures/ingress.js'
import { config, context } from './fixtures/room-binding.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture(running = false) { const f = await ingressFixture(running); cleanup.push(() => f.close()); return f }
function qualifier(f: Awaited<ReturnType<typeof fixture>>, read: NonNullable<IngressAuthenticator['qualifyReply']>) {
  vi.spyOn(f.connections, 'resolveCredential').mockResolvedValue('trusted-host-credential')
  const port: IngressAuthenticator = f.options.authenticators[0]!, result = vi.fn(read)
  port.qualifyReply = result
  return result
}

it('ACK precedes parent lookup; unknown keeps the original body and public CLI receipt until an exact reply is qualified', async () => {
  const f = await fixture(), submit = vi.spyOn(f.client, 'submitAgentMessage')
  const read = qualifier(f, vi.fn().mockRejectedValueOnce(new Error('Private parent lookup failure')).mockResolvedValue('reply'))
  const accepted = await f.receive({ selection: 'message', replyToMessageId: 'original-parent' }, () => {
    expect(read).not.toHaveBeenCalled()
    const disk = new DatabaseSync(f.databasePath)
    try { expect(JSON.parse(String(disk.prepare('SELECT raw_payload FROM connection_ingress_event').get()!.raw_payload)).event).toMatchObject({ replyToMessageId: 'original-parent', body: f.event().body }) }
    finally { disk.close() }
  })
  const unknown = await f.ingress.dispatch(accepted.ingress.ingressId)
  expect(unknown.ingress).toMatchObject({ state: 'received', body: f.event().body, addressing: { state: 'unknown', reason: 'reply-unconfirmed', replyToMessageId: 'original-parent' } })
  expect(submit).not.toHaveBeenCalled()
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'qualified.sock'), connections: f.connections, coreClients: f.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const cli = () => runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'connection', 'ingress', 'inspect', '--ingress', accepted.ingress.ingressId], objectCliEnvironment(f.root))
  const detail = await cli()
  expect(detail.code, detail.stderr).toBe(0)
  expect(JSON.parse(detail.stdout).result).toMatchObject({ ingress: unknown.ingress, inputReceipt: null, observation: 'not-started' })
  expect(detail.stdout).not.toContain('trusted-host-credential'); expect(detail.stdout).not.toContain('Private parent lookup failure')
  expect(() => parseConnectionIngressRecord({ ...unknown.ingress, addressing: { ...unknown.ingress!.addressing, selection: 'reply' } })).toThrow()
  for (const addressing of [{ state: 'confirmed', selection: ['reply'] }, { state: 'unavailable', reason: ['credential-missing'] }]) {
    expect(() => parseConnectionIngressRecord({ ...unknown.ingress, addressing: { replyToMessageId: 'original-parent', ...addressing } })).toThrow()
  }
  // A new Host observation resumes the original received record, never a new transport identity.
  const resumed = new DurableIngressHost(f.options), known = await resumed.dispatch(accepted.ingress.ingressId)
  expect(known.ingress).toMatchObject({ ingressId: accepted.ingress.ingressId, state: 'claimed', body: f.event().body, addressing: { state: 'confirmed', selection: 'reply', replyToMessageId: 'original-parent' } })
  expect(submit).toHaveBeenCalledOnce()
  const queued = await new core.DurableAgentMuxMessageQueue(f.client.agentMessageQueuePath()).readByOperationId(known.ingress!.input!.operationId)
  expect(queued!.envelope.body).toBe(f.event().body)
  expect(queued!.envelope.sender).toEqual(known.ingress!.input!.author)
  const redelivery = await f.receive({ selection: 'message', replyToMessageId: 'original-parent' })
  expect(redelivery.ingress).toEqual(known.ingress)
  const originalEvent = JSON.parse(String(f.connections.database.prepare('SELECT event_json FROM connection_ingress_message').get()!.event_json))
  expect(originalEvent.selection).toBe('message')
  expect(read.mock.calls[1]![1]).toMatchObject({ selection: 'message', replyToMessageId: 'original-parent' })
  expect((await cli()).code).toBe(0)
})

it('a confirmed other author refuses this reply while a grant revoked during lookup never reaches Core input', async () => {
  const f = await fixture(true), submit = vi.spyOn(f.client, 'submitAgentMessage')
  const read = qualifier(f, async () => 'message')
  const other = await f.receive({ selection: 'message', replyToMessageId: 'other-author-parent' })
  expect((await f.ingress.dispatch(other.ingress.ingressId)).ingress).toMatchObject({ state: 'refused', code: 'INGRESS_INPUT_OUTSIDE_SCOPE', addressing: { state: 'confirmed', selection: 'message' } })
  read.mockImplementationOnce(async () => {
    await f.bindings.grant({ ...f.grant, operationId: 'revoke-during-parent-read', expectedRevision: 1, state: 'revoked' }, context)
    return 'reply'
  })
  const revoked = await f.receive({ eventId: 'later-event', messageId: 'later-message', selection: 'message', replyToMessageId: 'original-parent' })
  expect((await f.ingress.dispatch(revoked.ingress.ingressId)).ingress).toMatchObject({ state: 'refused', code: 'INGRESS_ACTOR_NOT_AUTHORIZED' })
  expect(submit).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  await f.client.submitAgentPrompt({ agentSessionId: f.input.agentSessionId, expectedRun: f.session.run, operationId: 'local-after-parent-read', prompt: 'Original local input remains available', admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', authorHuman: true })
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('unsupported authenticated content is fully durable before ACK and never becomes fabricated input', async () => {
  const f = await fixture(), submit = vi.spyOn(f.client, 'submitAgentMessage')
  const original = JSON.stringify({ proof: 'adapter-private-witness', event: f.event({ body: '', unsupportedContent: true }), originalContent: { attachments: ['complete native payload '.repeat(15_000)] } })
  const ack = vi.fn(() => {
    const disk = new DatabaseSync(f.databasePath)
    try {
      expect(disk.prepare('SELECT raw_payload FROM connection_ingress_event').get()!.raw_payload).toBe(original)
      expect(JSON.parse(String(disk.prepare('SELECT record_json FROM connection_ingress_message').get()!.record_json))).toMatchObject({ state: 'refused', code: 'INGRESS_CONTENT_UNSUPPORTED', body: '' })
    } finally { disk.close() }
  })
  const accepted = await f.ingress.receive({ connectionId: config.connectionId, raw: original }, ack)
  expect(ack).toHaveBeenCalledOnce()
  expect((await f.ingress.dispatch(accepted.ingress.ingressId)).ingress).toEqual(accepted.ingress)
  expect((await f.ingress.receive({ connectionId: config.connectionId, raw: original }, ack)).duplicate).toBe('event')
  expect(submit).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('missing or late parent observations retain the received operation without taking reply authority', async () => {
  const f = await fixture(), submit = vi.spyOn(f.client, 'submitAgentMessage')
  const accepted = await f.receive({ selection: 'message', replyToMessageId: 'original-parent' })
  expect((await f.ingress.dispatch(accepted.ingress.ingressId)).ingress).toMatchObject({ state: 'received', addressing: { state: 'unavailable', reason: 'adapter-unavailable' } })
  let finish!: (value: 'reply') => void
  const read = qualifier(f, async () => await new Promise<'reply'>(resolve => { finish = resolve }))
  vi.useFakeTimers()
  const observing = f.ingress.dispatch(accepted.ingress.ingressId)
  await vi.advanceTimersByTimeAsync(5_000)
  const timedOut = await observing
  expect(read.mock.calls[0]![4].aborted).toBe(true)
  expect(timedOut.ingress).toMatchObject({ state: 'received', addressing: { state: 'unknown', reason: 'reply-unconfirmed' } })
  finish('reply'); await Promise.resolve(); await Promise.resolve()
  expect((await f.ingress.inspect({ ingressId: accepted.ingress.ingressId })).ingress).toEqual(timedOut.ingress)
  expect(submit).not.toHaveBeenCalled()
})

it('a stuck credential observation releases the same intake and its late result cannot start a parent lookup', async () => {
  const f = await fixture(), submit = vi.spyOn(f.client, 'submitAgentMessage')
  const read = qualifier(f, async () => 'reply')
  let lateCredential!: (credential: string) => void
  const credentials = vi.spyOn(f.connections, 'resolveCredential').mockResolvedValue('current-credential')
    .mockImplementationOnce(async () => await new Promise<string>(resolve => { lateCredential = resolve }))
  const accepted = await f.receive({ selection: 'message', replyToMessageId: 'original-parent' })
  vi.useFakeTimers()
  const observing = f.ingress.dispatch(accepted.ingress.ingressId)
  await vi.advanceTimersByTimeAsync(5_000)
  expect((await observing).ingress).toMatchObject({ state: 'received', addressing: { state: 'unknown', reason: 'reply-unconfirmed' } })
  expect(credentials).toHaveBeenCalledOnce(); expect(read).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled()
  vi.useRealTimers()
  const recovered = await f.ingress.dispatch(accepted.ingress.ingressId)
  expect(recovered.ingress).toMatchObject({ ingressId: accepted.ingress.ingressId, state: 'claimed' })
  expect(read).toHaveBeenCalledOnce(); expect(read.mock.calls[0]![3]).toBe('current-credential')
  lateCredential('obsolete-credential')
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(read).toHaveBeenCalledOnce(); expect(submit).toHaveBeenCalledOnce()
  expect((await f.ingress.inspect({ ingressId: accepted.ingress.ingressId })).ingress).toEqual(recovered.ingress)
})
