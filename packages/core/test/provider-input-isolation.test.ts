import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentProviderRegistry, type AgentProvider } from '../src/agent-provider.js'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

// Run the original listener worker from source without building a Core artifact.
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, fork: ((path: string | URL, args: readonly string[], options: import('node:child_process').ForkOptions) =>
    actual.fork(String(path).endsWith('/control-endpoint-listener-worker.js')
      ? fileURLToPath(new URL('../src/control-endpoint-listener-worker.ts', import.meta.url)) : path, args, options)) as typeof actual.fork }
})

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
const providers = new AgentProviderRegistry().list().filter(provider => provider.catalog.capabilities.terminal)
if (!providers.length) throw new Error('Provider input isolation requires a nonempty registry')
const prompt = 'Independent manual input 原文\n{"draft":"opaque"}'
const user = { principal: { kind: 'user' as const, id: 'fixture-user' } }

/** Real public Core/RPC, journal, Store and builtin terminal plans. Native
 * qualification and Runtime byte IO are fixture ports, not native CLI proof. */
it.each(providers)('$id keeps native qualification failure scoped to its original input', async builtin => {
  const h = await rpcOwnerFixture(['recipient'], undefined, () => ({ providerId: builtin.id, executorId: builtin.id,
    nativeHandle: { kind: 'provider', providerId: builtin.id, sessionId: 'original-native' } }))
  let server: AgentMuxControlServer | undefined
  try {
    const initial = (await h.store.readMetadata('recipient'))!
    h.inner.kernel.status = vi.fn(async id => ({ ...h.run(id), pid: 1234 }))
    const prepare = vi.fn<NonNullable<AgentProvider['prepareNativeInput']>>(async () => {
      throw new AgentMuxError('The selected native input fact is unconfirmed', 'AGENT_NATIVE_INPUT_UNAVAILABLE')
    })
    const unrelated = vi.fn(async () => { throw new Error('Manual input must not depend on optional native/display observation') })
    const registry = Reflect.get(h.client, 'providers') as AgentProviderRegistry
    registry.replace({ ...builtin, prepareNativeInput: prepare, inspectPromptExecution: unrelated,
      readPromptExecutionEvidence: unrelated, preparePromptExecutionTransport: unrelated, verifyPromptExecutionTransport: unrelated })
    const key = (submissionId: string) => ({ kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: initial.run, submissionId })
    const native = { agentSessionId: 'recipient', operationId: 'native-original', expectedRun: initial.run,
      admissionIntent: { kind: 'native-conversation' as const, source: { providerId: builtin.id, nativeSessionId: 'original-native' } },
      execution: 'immediate' as const, prompt: 'Retain the original selected input' }
    await h.client.submitAgentPrompt(native)
    await expect.poll(async () => (await h.client.inspectAgentInput({ key: key(native.operationId) }))?.control.waiting).toMatchObject({
      phase: 'input-environment', wake: 'explicit-rejoin', failure: { code: 'AGENT_NATIVE_INPUT_UNAVAILABLE' }
    })
    expect(await h.client.inspectAgentPromptSubmission(key(native.operationId))).toBeNull()
    expect(prepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ processId: 1234 }), native.admissionIntent.source)
    expect(h.inner.kernel.input).not.toHaveBeenCalled()

    const rpc = new AgentMuxRpcService({ coreClients: h.coreClients })
    const manual = { agentSessionId: 'recipient', operationId: 'manual-independent', expectedRun: initial.run,
      admissionIntent: { kind: 'manual-actor' as const }, execution: 'immediate' as const, prompt }
    await rpc.call('agent.input.submit', manual, user)
    await expect.poll(async () => {
      const receipt = await h.client.inspectAgentInput({ key: key(manual.operationId) })
      return receipt?.status === 'terminal-confirmed' || receipt?.control.waiting?.failure?.code === 'AGENT_NATIVE_INPUT_UNAVAILABLE'
    }).toBe(true)
    expect(await h.client.inspectAgentInput({ key: key(manual.operationId) }), 'Optional native qualification must not reject independent terminal input')
      .toMatchObject({ status: 'terminal-confirmed' })
    const plan = builtin.planPromptInput(prompt, { execution: 'immediate' })
    const frames = plan.kind === 'single-phase' ? [plan.data] : [plan.payload, plan.submit]
    expect(vi.mocked(h.inner.kernel.input as (...args: any[]) => unknown).mock.calls.map(call => [call[0], call[1].data]))
      .toEqual(frames.map(data => [initial.run.runId, data]))
    expect(unrelated).not.toHaveBeenCalled()
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(h.rawInput).not.toHaveBeenCalled()
    expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    expect(h.client.agentSession('recipient').run).toEqual(initial.run)
    expect(await h.client.inspectAgentInput({ key: key(native.operationId) })).toMatchObject({ key: key(native.operationId), status: 'waiting' })
    expect(await h.client.inspectAgentPromptSubmission(key(native.operationId))).toBeNull()
    await expect(rpc.call('agent.input.submit', { ...manual, operationId: 'wrong-run', expectedRun: { runId: 'foreign-run' } }, user))
      .rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
    expect(h.inner.kernel.input).toHaveBeenCalledTimes(frames.length)

    // One actual source CLI consumes the same public owner and original key.
    if (builtin.id === providers[0]!.id) {
      server = new AgentMuxControlServer({ socketPath: join(h.root, 'control.sock'), coreClients: h.coreClients })
      await server.start()
      const read = await runSourceObjectCli(['--endpoint', 'unix://' + server.path, 'agent', 'input', 'inspect', '--input', '-'],
        objectCliEnvironment(h.root, { AGENTMUX_AGENT_SESSION_ID: 'recipient', AGENTMUX_AGENT_CAPABILITY: h.capability }),
        JSON.stringify({ key: key(manual.operationId) }))
      expect(read.code, read.stderr + read.stdout).toBe(0)
      expect(JSON.parse(read.stdout).result.input).toMatchObject({ key: key(manual.operationId), status: 'terminal-confirmed' })
    }
  } finally {
    try { await server?.stop() } finally { await h.close() }
  }
})
