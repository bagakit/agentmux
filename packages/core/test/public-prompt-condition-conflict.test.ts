import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentProviderRegistry, defineAgentProvider } from '../src/agent-provider.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

it.each(['single-phase', 'render-then-submit'] as const)('keeps known conflicts and missing identity distinct for %s', async kind => {
  const h = await rpcOwnerFixture(['recipient'])
  try {
    const providers = (h.client as unknown as { providers: AgentProviderRegistry }).providers
    const template = providers.get('codex')
    const { providerFork: _fork, promptExecution: _immediate, ...capabilities } = template.catalog.capabilities
    const definition = { catalog: { ...template.catalog, capabilities, id: 'conflict-plan',
      label: 'Conflict plan', executable: 'conflict-plan', expectedProcess: 'conflict-plan' },
      hook: template.hook, ...(template.planManagedHooks ? { planManagedHooks: template.planManagedHooks } : {}),
      buildArgs: (_prompt: string | undefined, args: readonly string[]) => [...args] }
    providers.register(defineAgentProvider(definition))
    const original = (await h.store.load())[0]!
    await h.store.compareAndSwap(original, { ...original, providerId: 'conflict-plan', executorId: 'conflict-plan' })
    await h.inner.registry.load('local')
    let cursor = 0
    const writes: string[] = []
    h.inner.kernel.identity = () => ({ daemonInstanceId: 'conflict-native', protocolVersion: 21, buildIdentity: 'fixture' })
    h.inner.kernel.status = async (id: string) => ({ ...h.run(id), latestOutputBytes: 0, acceptedInputBytes: cursor })
    h.inner.kernel.input = async (id: string, input: { expectedByte: number; data: string }) => {
      writes.push(input.data); const startByte = cursor; cursor += Buffer.byteLength(input.data)
      return { run: { ...h.run(id), latestOutputBytes: 0, acceptedInputBytes: cursor }, appliedByteRange: { startByte, endByte: cursor } }
    }
    await h.client.submitAgentPrompt({ agentSessionId: 'recipient', expectedRun: original.run,
      afterSubmissionId: null, operationId: 'later', prompt: 'Later message' })
    providers.register(defineAgentProvider({ ...definition, catalog: { ...definition.catalog, id: 'conflict-next' },
      ...(kind === 'render-then-submit' ? { terminalPromptRender: template.terminalPromptRender!,
        planPromptInput: (text: string) => ({ kind: 'render-then-submit' as const, payload: text, renderedText: text, submit: '\r' }) } : {}) }))
    const current = (await h.store.load())[0]!
    await h.store.compareAndSwap(current, { ...current, providerId: 'conflict-next', executorId: 'conflict-next' })
    await h.inner.registry.load('local')
    const before = (await h.store.load())[0]!
    for (const predecessor of [null, 'different-predecessor']) {
      await expect(h.client.submitAgentPrompt({ agentSessionId: 'recipient', expectedRun: original.run,
        afterSubmissionId: predecessor, operationId: 'old', prompt: 'Retained original', allowUncertainTurn: true }))
        .rejects.toMatchObject({ code: 'AGENT_PROMPT_CONDITION_CHANGED',
          controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
      expect((await h.store.load())[0]!.promptCompletionAdmission).toEqual(before.promptCompletionAdmission)
    }
    const admission = { ...before.promptCompletionAdmission! }; delete admission.submissionId
    await h.store.compareAndSwap(before, { ...before, promptCompletionAdmission: admission })
    await expect(h.client.submitAgentPrompt({ agentSessionId: 'recipient', expectedRun: original.run,
      afterSubmissionId: null, operationId: 'old', prompt: 'Retained original', allowUncertainTurn: true }))
      .rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED', controlFailure: undefined })
    expect(writes).toEqual(['Later message\r'])
    expect(h.client.agentSession('recipient').run).toEqual(original.run)
    expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it('carries the real pre-input condition conflict through RPC, compiled CLI and the original journal', async () => {
  const h = await rpcOwnerFixture(['caller', 'recipient'])
  let server: AgentMuxControlServer | undefined
  let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
  let reader: Awaited<ReturnType<typeof connectHostedAgentMux>> | undefined
  let hosted: AgentMuxHostedRuntimeService | undefined
  try {
    const providers = (h.client as unknown as { providers: AgentProviderRegistry }).providers
    const template = providers.get('codex')
    const { providerFork: _fork, promptExecution: _immediate, ...capabilities } = template.catalog.capabilities
    providers.register(defineAgentProvider({ catalog: { ...template.catalog, capabilities,
      id: 'condition-fixture', label: 'Condition fixture', executable: 'condition-fixture', expectedProcess: 'condition-fixture' },
      hook: template.hook, ...(template.planManagedHooks ? { planManagedHooks: template.planManagedHooks } : {}),
      buildArgs: (_prompt, args) => [...args] }))
    for (const record of await h.store.load()) await h.store.compareAndSwap(record,
      { ...record, providerId: 'condition-fixture', executorId: 'condition-fixture' })
    await h.inner.registry.load('local')
    let cursor = 0
    const writes: string[] = []
    const run = (id: string) => ({ ...h.run(id), latestOutputBytes: 0, acceptedInputBytes: cursor })
    h.inner.kernel.status = async (id: string) => run(id)
    h.inner.kernel.identity = () => ({ daemonInstanceId: 'condition-native', protocolVersion: 21, buildIdentity: 'fixture' })
    h.inner.kernel.input = async (id: string, operation: { expectedByte: number; data: string }) => {
      expect(operation.expectedByte).toBe(cursor)
      writes.push(operation.data)
      const startByte = cursor; cursor += Buffer.byteLength(operation.data)
      return { run: run(id), appliedByteRange: { startByte, endByte: cursor } }
    }
    // A second real SDK submission arrives after the public envelope freezes its
    // condition, before its Core input owner enters the Store lock.
    const submit = h.client.submitAgentMessage.bind(h.client)
    vi.spyOn(h.client, 'submitAgentMessage').mockImplementationOnce(async input => {
      await h.client.submitAgentPrompt({ agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' },
        afterSubmissionId: null, operationId: 'later-admission', prompt: 'A different explicit message' })
      return submit(input)
    })
    hosted = new AgentMuxHostedRuntimeService(h.client, h.store.path, () => ({ runtimeId: 'condition-runtime',
      ownerInstanceId: 'condition-owner', protocolVersion: 1, processId: process.pid,
      ctxmux: h.client.runtimeIdentity(), availability: 'connected' }))
    const socketPath = join(h.root, 'control.sock')
    server = new AgentMuxControlServer({ socketPath, coreClients: h.coreClients, hostedRuntime: () => hosted })
    await server.start()
    rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
    const env = objectCliEnvironment(h.root, { AGENTMUX_AGENT_SESSION_ID: 'caller', AGENTMUX_AGENT_CAPABILITY: h.capability })
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'agent', 'send',
      '--to-session', 'recipient', '--text', 'Original retained body', '--operation-id', 'old-control', '--message-id', 'old-message'], env)
    expect(result.code, result.stderr).toBe(1)
    const failure = JSON.parse(result.stderr.split('\n').find(line => line.startsWith('{'))!).error
    expect(failure).toMatchObject({ code: 'AGENT_PROMPT_CONDITION_CHANGED',
      controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 }, logId: expect.any(String) })
    const inspected = await runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'message', 'delivery',
      'inspect', '--logid', failure.logId, '--host-id', 'local'], env)
    expect(inspected.code, inspected.stderr).toBe(0)
    expect(JSON.parse(inspected.stdout).result).toMatchObject({ availability: 'found', record: {
      operationId: 'old-message', afterSubmissionId: null, stage: 'input-coordination',
      error: { code: failure.code, controlFailure: failure.controlFailure },
      observation: { submissionId: 'later-admission' }
    } })
    reader = await connectHostedAgentMux({ rpc })
    expect(reader.agentSession('recipient')).toMatchObject({ run: { runId: 'run-recipient' },
      promptCompletionAdmission: { submissionId: 'later-admission', acknowledged: true } })
    expect(writes).toEqual(['A different explicit message\r'])
    expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { await reader?.dispose(); await rpc?.dispose(); await server?.stop(); hosted?.dispose(); await h.close() }
}, 30_000)
