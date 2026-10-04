import { fixturePath } from './helpers/fixture-values.js'
import { mkdtemp, rm } from 'node:fs/promises'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DeliveryAttemptStore } from '../src/delivery-attempt-store.js'
import { newDeliveryLogId, type DeliveryAttempt } from '../src/delivery-attempt.js'
import { AgentMuxError } from '../src/errors.js'
import type { AgentMuxPendingMessage } from '../src/pending-message-control.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { rpcFailure } from '../src/public-rpc-frame.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { ObjectCliProbe } from './helpers/object-cli-rpc.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function probe(handle: ConstructorParameters<typeof ObjectCliProbe>[0]) {
  const fixture = new ObjectCliProbe(handle)
  cleanup.push(() => fixture.stop())
  await fixture.start()
  return fixture
}

const target = { agentSessionId: 'original-session', pendingId: 'original-pending', expectedText: 'original pending body' }
function pending(archived: boolean): AgentMuxPendingMessage {
  return { pendingId: target.pendingId, text: target.expectedText, runId: 'original-run', enqueuedAt: 1,
    status: 'deferred', phase: null, editable: !archived, delivery: 'not-submitted', errorCode: null, error: null, archived }
}

describe('public message receipts retain their exact target and diagnostic ID', () => {
  it.each([
    ['message.pending.archive', 'agentSessionId'],
    ['message.pending.archive', 'pendingId'],
    ['message.pending.restore', 'agentSessionId'],
    ['message.pending.restore', 'pendingId']
  ] as const)('rejects %s receipts with another %s through the actual Unix RPC client', async (method, changedField) => {
    const valid = { agentSessionId: target.agentSessionId, message: pending(method === 'message.pending.archive'), changed: true }
    let result = valid
    const fixture = await probe(() => result)
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: fixture.socketPath } })
    cleanup.push(() => rpc.dispose())
    const params = { ...target, operationId: 'original-archive-or-restore-operation' }
    // First prove that the action-specific DTO is valid, independently of the target guard.
    await expect(rpc.call(method, params)).resolves.toEqual(valid)
    result = changedField === 'agentSessionId'
      ? { ...valid, agentSessionId: 'foreign-session' }
      : { ...valid, message: { ...valid.message, pendingId: 'foreign-pending' } }
    await expect(rpc.call(method, params)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    expect(fixture.requests).toHaveLength(2)
    for (const request of fixture.requests) {
      expect(request).toMatchObject({ method, params })
      expect(request.id).not.toBe(params.operationId)
    }
  })

  it('preserves the validated stream error logId in the actual onEnd error', async () => {
    let streamSocket: Socket | undefined
    const fixture = await probe((_request, socket) => {
      streamSocket = socket
      return { subscriptionId: 'original-reader', method: 'browser.follow', initial: { runOperation: null, gap: null } }
    })
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: fixture.socketPath } })
    cleanup.push(() => rpc.dispose())
    const original = { code: 'ORIGINAL_READER_FAILURE', message: 'The original reader failed.', detail: 'original reader detail',
      controlFailure: { disposition: 'unknown' as const, confirmedInputBytes: 7 }, logId: newDeliveryLogId() }
    const events: unknown[] = [], endings: Array<Error | undefined> = []
    let end!: (error: Error | undefined) => void
    // This Promise observes the existing onEnd API; it adds no product subscription member.
    const closed = new Promise<Error | undefined>(resolve => { end = resolve })
    let initial: unknown
    const sub = await rpc.subscribe('browser.follow', { operationId: 'original-browser-operation', afterSequence: 0 }, {
      onInitial: value => { initial = value }, onEvent: value => { events.push(value) },
      onEnd: error => { endings.push(error); end(error) } })
    expect(initial).toEqual({ runOperation: null, gap: null })
    expect(sub.subscriptionId).toBe('original-reader')
    // The existing probe owns the real Unix socket; write the native public notification frame.
    // Capture its socket on the original request instead of fabricating an RPC client or callback.
    expect(fixture.requests).toHaveLength(1)
    const notification = { jsonrpc: '2.0', method: 'system.subscription.event', params: {
      subscriptionId: sub.subscriptionId, method: 'browser.follow', sequence: 1, event: { type: 'error', error: original } } }
    streamSocket!.write(JSON.stringify(notification) + '\n')
    await expect(closed).resolves.toMatchObject(original)
    expect(events).toEqual([{ type: 'error', error: original }])
    expect(endings).toHaveLength(1)
    await sub.dispose()
    expect(endings).toHaveLength(1)
  })

  it('preserves a failed pending Send logId in stderr from the actual compiled CLI', async () => {
    const original = new AgentMuxError('The original pending Send was refused.', 'AGENT_INTERACTION_PENDING', 'original pending detail',
      { disposition: 'not_applied', confirmedInputBytes: 0 }, newDeliveryLogId())
    const fixture = await probe((request, socket) => {
      // Use the production error encoder; the helper default intentionally projects fewer fields.
      socket.write(JSON.stringify(rpcFailure(request.id, original)) + '\n')
    })
    const operationId = 'original-cli-pending-send-operation'
    const result = await fixture.run(['message', 'pending', 'send', '--session', target.agentSessionId,
      '--pending-id', target.pendingId, '--operation-id', operationId])
    expect(result.code, result.stderr).toBe(1)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toEqual({ ok: false, operation: 'message.pending.send', operationId,
      error: { code: original.code, message: original.message, detail: original.detail,
        controlFailure: original.controlFailure, logId: original.logId } })
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.requests[0]).toMatchObject({ method: 'message.pending.send',
      params: { agentSessionId: target.agentSessionId, pendingId: target.pendingId, operationId } })
    expect(fixture.requests[0]!.id).not.toBe(operationId)
  }, 20_000)

  it('reports and inspects the original immutable client diagnostic through actual Unix dispatch', async () => {
    const root = await mkdtemp(fixturePath("tmp/amx-receipt-integrity-"))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const store = new DeliveryAttemptStore(join(root, 'reports'))
    const original: DeliveryAttempt = { logId: newDeliveryLogId(), source: 'client', agentSessionId: target.agentSessionId,
      operationId: 'original-report-operation', hostId: 'original-target-host', expectedRunId: 'original-run',
      afterSubmissionId: null, conditionAvailable: true, promptDigest: 'digest-only', execution: 'immediate',
      startedAt: 1, failedAt: 2, stage: 'core-submit', error: { name: 'Error', code: 'EIO',
        message: 'The original writer could not be read.', detail: 'original cause' } }
    const socketPath = join(root, 'owner.sock'), hostId = 'original-receiving-host'
    const server = new AgentMuxControlServer({ socketPath, coreClients: () => [], deliveryAttempts: { hostId, store } })
    cleanup.push(() => server.stop())
    await server.start()
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
    cleanup.push(() => rpc.dispose())
    const report = rpc.call('message.delivery.report', { hostId, record: original })
    await expect(report).resolves.toMatchObject({ logId: original.logId, availability: 'found', persistence: 'confirmed',
      record: { ...original, reporter: { kind: 'user', routeHostId: hostId } } })
    const reported = await report
    await expect(rpc.call('message.delivery.inspect', { hostId, logId: original.logId })).resolves.toMatchObject({
      logId: original.logId, availability: 'found', persistence: 'confirmed', record: reported.record })
    expect((await new DeliveryAttemptStore(store.directory).read(original.logId)).record).toEqual(reported.record)
    expect(JSON.stringify(reported)).not.toContain(target.expectedText)
  })
})
