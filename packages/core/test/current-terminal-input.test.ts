import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import type { AgentInputSubmissionReceipt } from '../src/agent-input-wait.js'
import { parseAgentMuxControlReceipt } from '../src/control-codec.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

// Actual Core, Provider encoding, journal, admission Store and public transports.
// Only the Runtime byte port is controlled; Native consumption is a separate proof.
async function fixture(providerId = 'codex') {
  const h = await rpcOwnerFixture()
  if (providerId !== 'codex') {
    const previous = (await h.store.readMetadata('recipient'))!
    await h.store.compareAndSwapMetadata(previous, { ...previous, providerId, executorId: providerId })
    await h.inner.registry.load('local')
  }
  let cursor = 0
  const accepted = new Map<string, { expectedByte: number; data: string }>()
  h.inner.kernel.identity = () => ({ daemonInstanceId: 'original-runtime', protocolVersion: 1, buildIdentity: 'controlled' })
  h.inner.kernel.status = async (id: string) => ({ ...h.run(id), acceptedInputBytes: cursor })
  const write = vi.fn(async (id: string, op: { operationId: string; expectedByte: number; data: string }) => {
    const prior = accepted.get(op.operationId)
    if (prior) expect(op).toMatchObject(prior)
    else {
      expect(op.expectedByte).toBe(cursor)
      accepted.set(op.operationId, { expectedByte: op.expectedByte, data: op.data })
      cursor += Buffer.byteLength(op.data)
    }
    return { run: { ...h.run(id), acceptedInputBytes: cursor },
      appliedByteRange: { startByte: op.expectedByte, endByte: op.expectedByte + Buffer.byteLength(op.data) } }
  })
  h.inner.kernel.input = write
  const display = vi.spyOn(Reflect.get(h.client, 'screenEvidence'), 'wait')
    .mockRejectedValue(new Error('A display observation cannot authorize current-terminal input.'))
  const input = (id: string, prompt = 'Original body\n原文') => ({ agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' },
    operationId: id, prompt, admissionIntent: { kind: 'manual-actor' as const }, execution: 'immediate' as const, authorHuman: true })
  const key = (id: string) => ({ kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, submissionId: id })
  const read = (id: string) => h.client.inspectAgentInput({ key: key(id) })
  const settled = async (id: string) => {
    try { await expect.poll(async () => (await read(id))?.status).toBe('terminal-confirmed') }
    catch { expect((await read(id))?.status).toBe('terminal-confirmed') }
    return (await read(id))!
  }
  return { ...h, write, accepted, display, input, key, read, settled }
}

it.each(['codex', 'claude', 'kimi'])('submits on the original %s terminal without Native metadata, socket, or display qualification', async providerId => {
  const h = await fixture(providerId)
  try {
    expect(h.client.providers.get(providerId).catalog.capabilities.promptExecution?.immediate).toBe('terminal-submit')
    const saved = await h.client.submitAgentPrompt(h.input('manual')) as AgentInputSubmissionReceipt
    expect(saved).toMatchObject({ persistence: 'confirmed', key: h.key('manual') })
    const result = await h.settled('manual')
    expect(result.admission?.admission).toMatchObject({ acknowledged: true, inputKey: h.key('manual'),
      inputDispatch: { ref: saved.ref, gateId: result.control.gateId }, intent: { admissionIntent: { kind: 'manual-actor' } } })
    expect(result.admission?.admission?.transport).not.toBe('native')
    expect(h.write).toHaveBeenCalled()
    expect([...h.accepted.values()].map(op => op.data).join('')).toContain('Original body\n原文')
    expect(h.display).not.toHaveBeenCalled()
    expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    expect(await h.client.stopAgentInputWaiting({ ref: saved.ref, cancelOperationId: 'stop-after-byte-confirmation' }))
      .toMatchObject({ outcome: 'already-settled' })
  } finally { await h.close() }
})

it('continues an original saved pre-dispatch wait without requiring its old Native locator observation', async () => {
  const h = await fixture(), input = h.input('original-saved-wait')
  const queue = new DurableAgentMuxMessageQueue(h.client.agentMessageQueuePath())
  try {
    const original = await queue.savePromptInput({ key: h.key(input.operationId),
      admissionIntent: { kind: 'manual-actor', expectedRun: input.expectedRun }, execution: 'immediate',
      environment: { providerId: 'codex', executorId: 'codex',
        nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'old-locator-observation' } },
      source: { kind: 'prompt', prompt: input.prompt, authorHuman: true, sourceChannel: 'api' } })
    await queue.recordInputWaiting(original!.control.ref, { phase: 'native-environment',
      reason: 'original-environment-unconfirmed', wake: 'explicit-rejoin', mechanism: 'unconfirmed' })
    const resumed = await h.client.submitAgentPrompt(input) as AgentInputSubmissionReceipt
    expect(resumed.ref).toEqual(original!.control.ref)
    expect((await h.settled(input.operationId)).status).toBe('terminal-confirmed')
    expect(h.write).toHaveBeenCalledTimes(2)
    const before = h.write.mock.calls.length
    await h.client.submitAgentPrompt(input)
    expect((await h.read(input.operationId))?.status).toBe('terminal-confirmed')
    expect(h.write).toHaveBeenCalledTimes(before)
    expect(h.display).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it('keeps a large single-line paste framed through the actual Core phases', async () => {
  const h = await fixture(), body = 'x'.repeat(48 * 1024)
  try {
    await h.client.submitAgentPrompt(h.input('large', body))
    const receipt = await h.settled('large')
    const phases = [...h.accepted.values()]
    expect(phases.map(op => op.data)).toEqual(['\u001b[200~' + body + '\u001b[201~', '\r'])
    expect(receipt.admission?.admission?.intent?.prompt).toBe(body)
    expect(receipt.admission?.terminalPromptSubmission?.payload.acknowledged).toBe(true)
    expect(receipt.admission?.terminalPromptSubmission?.submit.acknowledged).toBe(true)
    expect(h.display).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it('rejects mixed original identities and byte ranges on both public receipt boundaries', async () => {
  const h = await fixture()
  try {
    await h.client.submitAgentPrompt(h.input('receipt-boundary'))
    const original = await h.settled('receipt-boundary')
    const readBoth = (input: AgentInputSubmissionReceipt) => [
      () => parseAgentMuxControlReceipt({ schemaVersion: 5, requestId: 'receipt-review', ok: true, operation: 'send',
        result: { agentSessionId: input.key.agentSessionId, inputReceipt: input } }),
      () => parseRpcNativeResult('agent.input.inspect', { record: input.admission, input }, { key: original.key })
    ]
    for (const read of readBoth(original)) expect(read).not.toThrow()
    const differentInput = structuredClone(original)
    differentInput.control.ref.key = { ...h.key('another-original-input') }
    const invalidRange = structuredClone(original)
    if (invalidRange.admission!.admission!.transport !== 'native') invalidRange.admission!.admission!.startByte = -1
    const unrelatedPhases = structuredClone(original)
    for (const phase of ['payload', 'submit'] as const) {
      unrelatedPhases.admission!.terminalPromptSubmission![phase].inputByteRange.startByte += 1000
      unrelatedPhases.admission!.terminalPromptSubmission![phase].inputByteRange.endByte += 1000
    }
    for (const input of [differentInput, invalidRange, unrelatedPhases]) {
      for (const read of readBoth(input)) expect(read).toThrow()
    }
    expect((await h.read('receipt-boundary'))?.status).toBe('terminal-confirmed')
    expect(h.write).toHaveBeenCalledTimes(2)
  } finally { await h.close() }
})

it('reports a new original claim refused before the first Runtime call as not-applied and allows the next message', async () => {
  const h = await fixture()
  let authorReads = 0
  try {
    const first = await h.client.submitAgentPrompt(h.input('refused'), { assertCurrent: () => {
      if (++authorReads === 3) throw new Error('Current author observation unavailable before any input.')
    } }) as AgentInputSubmissionReceipt
    try { await expect.poll(async () => (await h.read('refused'))?.status).toBe('not-applied') }
    catch { expect((await h.read('refused'))?.status).toBe('not-applied') }
    expect(h.write).not.toHaveBeenCalled()
    expect((await h.read('refused'))?.ref).toEqual(first.ref)
    await h.client.submitAgentPrompt(h.input('next'))
    await h.settled('next')
    const before = h.write.mock.calls.length
    await h.client.submitAgentPrompt(h.input('refused'))
    expect((await h.read('refused'))?.status).toBe('not-applied')
    expect(h.write).toHaveBeenCalledTimes(before)
  } finally { await h.close() }
})

it('serializes distinct idle and working manual inputs without a caller predecessor or consumed readiness gate', async () => {
  const h = await fixture()
  try {
    await h.client.submitAgentPrompt(h.input('idle'))
    await h.settled('idle')
    const previous = (await h.store.readMetadata('recipient'))!
    const now = Date.now()
    await h.store.compareAndSwapMetadata(previous, { ...previous, updatedAt: now,
      semanticStatus: { state: 'working', source: 'native-hook', observedAt: now, nativeTurnId: 'original-active-turn' } })
    await h.inner.registry.load('local')
    await Promise.all([h.client.submitAgentPrompt(h.input('working-A')), h.client.submitAgentPrompt(h.input('working-B'))])
    const a = await h.settled('working-A'), b = await h.settled('working-B')
    expect(a.admission?.admission?.intent?.admissionIntent).toEqual({ kind: 'manual-actor', expectedRun: { runId: 'run-recipient' } })
    expect(b.admission?.admission?.intent?.admissionIntent).toEqual(a.admission?.admission?.intent?.admissionIntent)
    expect(h.write).toHaveBeenCalledTimes(6)
    expect(h.display).not.toHaveBeenCalled()
    expect((await h.read('idle'))?.status).toBe('terminal-confirmed')
  } finally { await h.close() }
})

it('uses actual Unix, HTTP, Hosted SDK and compiled CLI for current-terminal input and exact byte receipts', async () => {
  const h = await fixture(), path = join(h.root, 'terminal-control.sock')
  const owner = new AgentMuxHostedRuntimeService(h.client, h.store.path, () => hostedTestOwner(h.client))
  const server = new AgentMuxControlServer({ socketPath: path, coreClients: h.coreClients, hostedRuntime: () => owner,
    http: { host: '127.0.0.1', port: 0, token: 'private-current-terminal' } })
  await server.start()
  const unix = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } })
  const http = await connectAgentMuxRpc({ endpoint: { transport: 'http', url: `http://127.0.0.1:${server.httpAddress!.port}/`, token: 'private-current-terminal' } })
  const hosted = await connectHostedAgentMux({ rpc: unix, waitForReady: false })
  const send = (operationId: string) => ({ target: { kind: 'agent-session' as const, agentSessionId: 'recipient' },
    execution: 'immediate' as const, operationId: 'op-' + operationId, messageId: operationId, text: 'Public body 原文' })
  const inspect = (id: string) => ({ key: { kind: 'message' as const, agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, messageId: id } })
  try {
    await hosted.submitAgentPrompt(h.input('hosted'))
    expect((await h.settled('hosted')).status).toBe('terminal-confirmed')
    for (const [rpc, id] of [[unix, 'unix'], [http, 'http']] as const) {
      const original = await rpc.call('agent.send', send(id))
      expect(original.inputReceipt?.persistence).toBe('confirmed')
      await expect.poll(async () => (await rpc.call('agent.input.inspect', inspect(id))).input?.status).toBe('terminal-confirmed')
      const before = h.write.mock.calls.length
      expect((await rpc.call('agent.send', send(id))).inputReceipt?.status).toBe('terminal-confirmed')
      expect(h.write).toHaveBeenCalledTimes(before)
    }
    const cli = await runCompiledObjectCli(['--endpoint', 'unix://' + path, 'agent', 'send', '--to-session', 'recipient',
      '--text', 'CLI current terminal body', '--execution', 'immediate', '--operation-id', 'op-cli', '--message-id', 'cli'], objectCliEnvironment(h.root))
    expect(cli.code, cli.stderr).toBe(0)
    await expect.poll(async () => (await unix.call('agent.input.inspect', inspect('cli'))).input?.status).toBe('terminal-confirmed')
    expect(h.display).not.toHaveBeenCalled()
    expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { await hosted.dispose(); await unix.dispose(); await http.dispose(); await server.stop(); await owner.dispose(); await h.close() }
}, 20_000)
