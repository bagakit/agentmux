import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentProviderRegistry, defineAgentProvider } from '../src/agent-provider.js'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { renderAgentMuxMessageEnvelope } from '../src/agent-message-render.js'
import type { AgentMuxRunInputData } from '../src/types.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { objectCliReceipt } from './helpers/object-cli-receipt.js'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('keeps a whole-refused public message final and explicitly sends a new reply on the original Run', async () => {
  // Real Store, Core submission, Unix RPC and compiled CLI. Only Native transport
  // facts are deterministic here; this does not attest a spawned Native process.
  const h = await rpcOwnerFixture(['owner', 'worker'])
  let hosted: AgentMuxHostedRuntimeService | undefined
  let server: AgentMuxControlServer | undefined
  let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
  let reader: Awaited<ReturnType<typeof connectHostedAgentMux>> | undefined
  try {
    const providers = (h.client as unknown as { providers: AgentProviderRegistry }).providers
    const template = providers.get('codex')
    providers.register(defineAgentProvider({
      catalog: { ...template.catalog, id: 'generic-message', label: 'Generic message',
        executable: 'generic-message', expectedProcess: 'generic-message' },
      hook: template.hook, ...(template.planManagedHooks ? { planManagedHooks: template.planManagedHooks } : {}),
      buildArgs: (_prompt, args) => [...args]
    }))
    for (const record of await h.store.load()) await h.store.compareAndSwap(record,
      { ...record, providerId: 'generic-message', executorId: 'generic-message' })
    await h.inner.registry.load('local')

    const cursors = new Map<string, number>()
    const writes: Array<{ runId: string; operationId: string; data: AgentMuxRunInputData }> = []
    const run = (runId: string) => ({ ...h.run(runId), pid: 123, latestOutputBytes: 0,
      acceptedInputBytes: cursors.get(runId) ?? 0 })
    h.inner.kernel.identity = () => ({ daemonInstanceId: 'public-whole-owner', protocolVersion: 21, buildIdentity: 'fixture' })
    h.inner.kernel.status = async (runId: string) => run(runId)
    let refuseRun: string | null = null
    const nativeInput = vi.fn(async (runId: string, operation: { operationId: string; expectedByte: number; data: AgentMuxRunInputData }) => {
      expect(operation.expectedByte).toBe(cursors.get(runId) ?? 0)
      if (refuseRun === runId) {
        refuseRun = null
        throw new AgentMuxError('The original Native input was conclusively not applied.',
          'CTXMUX_input_cursor_mismatch', 'not_applied', { disposition: 'not_applied', confirmedInputBytes: 0 })
      }
      writes.push({ runId, operationId: operation.operationId, data: operation.data })
      const endByte = operation.expectedByte + (typeof operation.data === 'string'
        ? Buffer.byteLength(operation.data) : operation.data.byteLength)
      cursors.set(runId, endByte)
      return { run: run(runId), appliedByteRange: { startByte: operation.expectedByte, endByte } }
    })
    h.inner.kernel.input = nativeInput
    const ownerIdentity = { runtimeId: 'public-whole-runtime', ownerInstanceId: 'public-whole-host',
      protocolVersion: 1 as const, processId: process.pid, ctxmux: h.client.runtimeIdentity(), availability: 'connected' as const }
    hosted = new AgentMuxHostedRuntimeService(h.client, h.store.path, () => ownerIdentity)
    const socketPath = join(h.root, 'control.sock')
    server = new AgentMuxControlServer({ socketPath, coreClients: h.coreClients, hostedRuntime: () => hosted })
    await server.start()
    rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
    const worker = { agentSessionId: 'worker', capability: h.capability }
    const threadId = 'original-thread', correlationId = 'original-correlation'
    const source = await rpc.call('agent.send', { operationId: 'source-operation', messageId: 'source-message',
      target: { kind: 'agent-session', agentSessionId: 'worker' }, text: 'original assignment', threadId, correlationId },
    { credentials: h.credentials })
    const dispatch = await rpc.call('message.dispatch.open', { sourceMessageId: source.messageId }, { credentials: h.credentials })
    expect(dispatch).toMatchObject({ sourceMessageId: source.messageId, originAwaits: true, threadId })
    const body = '  exact reply\n第二行  '
    const args = ['--endpoint', 'unix:' + socketPath, 'agent', 'send', '--to-session', 'owner', '--text', body,
      '--thread', threadId, '--correlation', correlationId, '--reply-to', source.messageId]
    const env = objectCliEnvironment(h.root, { AGENTMUX_AGENT_SESSION_ID: 'worker', AGENTMUX_AGENT_CAPABILITY: h.capability })
    refuseRun = 'run-owner'
    const first = await runCompiledObjectCli([...args, '--operation-id', 'refused-operation', '--message-id', 'refused-message'], env)
    expect(first.code, first.stderr).toBe(1)
    expect(first.stdout).toBe('')
    const errors = first.stderr.split('\n').filter(line => line.startsWith('{'))
    expect(errors).toHaveLength(1)
    const refused = objectCliReceipt(JSON.parse(errors[0]!))
    expect(refused).toMatchObject({ ok: false, operation: 'agent.send', operationId: 'refused-operation', error: {
      code: 'CTXMUX_input_cursor_mismatch', detail: 'not_applied',
      controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 }, logId: expect.any(String)
    } })
    const lookup = await rpc.call('message.delivery.inspect', { logId: refused.error.logId }, { credentials: worker })
    expect(lookup).toMatchObject({ availability: 'found', record: { operationId: 'refused-message', expectedRunId: 'run-owner',
      error: { code: refused.error.code, detail: refused.error.detail, controlFailure: refused.error.controlFailure } } })
    expect(nativeInput).toHaveBeenCalledTimes(2)
    expect(writes).toHaveLength(1)
    const original = (await new DurableAgentMuxMessageQueue(join(h.root, 'messages.ndjson')).listAfter())
      .find(message => message.envelope.messageId === 'refused-message')!
    expect(original).toMatchObject({ envelope: { operationId: 'refused-operation', body, threadId, correlationId,
      replyTo: source.messageId }, promptCondition: { expectedRun: { runId: 'run-owner' }, afterSubmissionId: null } })
    expect(h.client.agentSession('owner').promptCompletionAdmission).toMatchObject({ submissionId: 'refused-message', notApplied: true })

    // The actual Hosted bootstrap exposes the same original refusal without Input.
    reader = await connectHostedAgentMux({ rpc })
    expect(reader.agentSession('owner')).toMatchObject({ run: { runId: 'run-owner' },
      promptCompletionAdmission: { submissionId: 'refused-message', notApplied: true } })
    expect(nativeInput).toHaveBeenCalledTimes(2)
    await reader.dispose(); reader = undefined

    const oldRequest = { operationId: 'refused-operation', messageId: 'refused-message',
      target: { kind: 'agent-session' as const, agentSessionId: 'owner' }, text: body, sourceChannel: 'cli' as const,
      threadId, correlationId, replyTo: source.messageId }
    await expect(rpc.call('agent.send', oldRequest, { credentials: worker }))
      .rejects.toMatchObject({ code: 'AGENT_PROMPT_UNCONFIRMED' })
    await expect(rpc.call('agent.send', { ...oldRequest, operationId: 'different-control-operation' }, { credentials: worker }))
      .rejects.toMatchObject({ code: 'AGENT_PROMPT_UNCONFIRMED' })
    // Bypass only the RPC's conservative delivery-issue check: the real SDK must
    // also preserve the whole refusal after the Native failure has disappeared.
    await expect(h.client.submitAgentMessage({ agentSessionId: 'owner', envelope: original.envelope,
      condition: original.promptCondition!, sourceChannel: 'cli', caller: worker }))
      .rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_NOT_APPLIED', detail: 'not_applied' })
    expect(nativeInput).toHaveBeenCalledTimes(2)
    expect(writes).toHaveLength(1)
    expect(h.client.agentSession('owner').promptCompletionAdmission).toMatchObject({ submissionId: 'refused-message', notApplied: true })

    // Omitting both identity flags is an explicit new CLI Send; it preserves the
    // original conversation reference instead of retargeting the old message.
    const next = await runCompiledObjectCli(args, env)
    expect(next.code, next.stderr).toBe(0)
    const fresh = objectCliReceipt(JSON.parse(next.stdout))
    expect(fresh.ok).toBe(true)
    expect(fresh.operationId).not.toBe('refused-operation')
    expect(fresh.result.messageId).not.toBe('refused-message')
    expect(fresh.result.envelope).toMatchObject({ body, threadId, correlationId, replyTo: source.messageId,
      senderSessionId: 'worker', senderRunId: 'run-worker', recipientSessionId: 'owner', recipientRunId: 'run-owner' })
    expect(nativeInput).toHaveBeenCalledTimes(3)
    expect(writes).toHaveLength(2)
    expect(writes[1]).toMatchObject({ runId: 'run-owner', data: renderAgentMuxMessageEnvelope(fresh.result.envelope) + '\r' })
    const completed = await rpc.call('message.dispatch.report', { sourceMessageId: source.messageId,
      replyMessageId: fresh.result.messageId, kind: 'worker_done' }, { credentials: worker })
    expect(completed).toMatchObject({ sourceMessageId: source.messageId, threadId, originAwaits: false,
      events: [{ kind: 'worker_done', replyMessageId: fresh.result.messageId }] })
    expect((await rpc.call('agent.inspect', { agentSessionId: 'owner' }, { credentials: h.credentials })).session.run)
      .toEqual({ runId: 'run-owner' })
    expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { await reader?.dispose(); await rpc?.dispose(); await server?.stop(); hosted?.dispose(); await h.close() }
}, 30_000)
