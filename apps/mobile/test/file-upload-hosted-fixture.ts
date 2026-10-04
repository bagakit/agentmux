import { fixturePath } from '../../../test/fixture-values.mjs'
import { vi, expect } from 'vitest'
import { join } from 'node:path'
import { AgentMuxClient } from '../../../packages/core/src/client'
import { AgentProviderRegistry, defineAgentProvider } from '../../../packages/core/src/agent-provider'
import { AgentMuxFileAgentSessionStore } from '../../../packages/core/src/agent-session-store'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import type { AgentMuxHostedRpcPort } from '../../../packages/core/src/hosted-client-contract'
import { hostedTestOwner } from '../../../packages/core/test/helpers/hosted-runtime-port'
import { FileUploadOwner } from '../../desktop/src/main/file-upload-owner'

/** The original Hosted SDK, public socket, disk owners, Core admission and provider
 * all run. Only the private ctxmux process transport is synthetic; no Agent starts. */
export async function attachmentHostedFixture(root: string) {
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const providerId = 'private-file-consumer'
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: 'session-original', providerId, executorId: providerId,
    hookBindingId: 'private-binding', hookToken: 'private-hook', hostId: 'local', workspacePath: root,
    run: { runId: 'run-original' }, retiredRuns: [], createdAt: 1, updatedAt: 1,
    semanticStatus: { state: 'working', source: 'native-hook', observedAt: 1 } })
  const template = new AgentProviderRegistry().get('codex').catalog
  const { promptExecution: _execution, providerFork: _fork, ...ordinaryCapabilities } = template.capabilities
  const provider = defineAgentProvider({ catalog: { ...template, id: providerId, label: 'Private ordinary file consumer',
    capabilities: ordinaryCapabilities, hookStrategy: { kind: 'native', installation: 'unmanaged' } },
    buildArgs: (_, args) => [...args], hook: { rules: [] } })
  const core = new AgentMuxClient({ store, providers: [provider] })
  const inner = core as unknown as { connected: boolean; registry: { load(hostId: string): Promise<void> }; kernel: Record<string, unknown> }
  await inner.registry.load('local'); inner.connected = true
  let cursor = 0
  const writes: string[] = []
  const run = () => ({ runId: 'run-original', lifecycleOperationId: null, program: fixturePath("private-worker"), args: [],
    workspacePath: root, pid: 421, state: { type: 'running' as const }, cols: 100, rows: 30,
    latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: cursor })
  Object.assign(inner.kernel, { isConnected: () => true,
    identity: () => ({ daemonInstanceId: 'private-daemon', protocolVersion: 18, buildIdentity: 'private-worker' }),
    status: async () => run(), list: async () => [run()], stop: vi.fn(),
    input: vi.fn(async (_id: string, operation: { expectedByte: number; data: string }) => {
      expect(operation.expectedByte).toBe(cursor)
      writes.push(operation.data)
      const range = { startByte: cursor, endByte: cursor + Buffer.byteLength(operation.data) }; cursor = range.endByte
      return { run: run(), appliedByteRange: range }
    }) })
  vi.spyOn(core, 'connect').mockResolvedValue()
  const submit = vi.spyOn(core, 'submitAgentPrompt')
  const hosted = new AgentMuxHostedRuntimeService(core, store.path, () => hostedTestOwner(core))
  const owner = new FileUploadOwner(join(root, 'uploads'))
  const control = new AgentMuxControlServer({ fileUploads: owner, coreClients: () => [{ hostId: 'local', client: core }] }, join(root, 'rpc.sock'))
  await control.start()
  const publicClient = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: control.path } })
  const wire = (value: unknown) => JSON.parse(JSON.stringify(value))
  const port = {
    call: async (method: string, params: unknown, options: any) => wire(await hosted.call(method, wire(params), options)),
    subscribe: async (method: string, params: unknown, handlers: any) => {
      const stream = await hosted.subscribe(method, params, event => handlers.onEvent(wire(event)), handlers.signal ? { signal: handlers.signal } : {})
      handlers.onInitial(wire(stream.initial)); await stream.start?.()
      return { dispose: async () => await stream.dispose() }
    }
  } as unknown as AgentMuxHostedRpcPort
  const client = await connectHostedAgentMux({ rpc: port, forwardRpc: async (method, params) => await publicClient.call(method, params as never) })
  return { client, core, owner, writes, submit, async dispose() {
    await client.dispose(); await publicClient.dispose(); await control.stop(); await hosted.dispose(); await core.dispose()
  } }
}
