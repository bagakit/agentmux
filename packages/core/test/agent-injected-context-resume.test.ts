import { fixturePath } from './helpers/fixture-values.js'
import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxClient as DefaultClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { composeAgentPrompt } from '../src/agent-outbound-message.js'
import type { AgentMuxAgentSession, AgentMuxStoredAgentSession } from '../src/types.js'
const Client: typeof DefaultClient = process.env.AGENTMUX_TEST_INJECTED_CONTEXT_CLIENT
  ? (await import(process.env.AGENTMUX_TEST_INJECTED_CONTEXT_CLIENT)).AgentMuxClient : DefaultClient

it('public native resume preserves the original request and separates host context through real Core and FileStore', async () => {
  const root = await mkdtemp(fixturePath("tmp/amx-injected-resume-"))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime')); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const previous: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-agent', providerId: 'claude', executorId: 'claude',
    hostId: 'local', workspacePath: root, run: { runId: 'old-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1,
    hookBindingId: 'private-binding', hookToken: 'private-token', nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'original-native' } }
  await store.compareAndSwap(null, previous)
  const core = new Client({ store })
  const inner = core as unknown as { connected: boolean; registry: { load(hostId: string): Promise<void> }; kernel: Record<string, unknown>;
    hookServer: Record<string, unknown>; ensureManagedHooks: unknown; ensureTerminalHandshakeOrDegrade: unknown }
  await inner.registry.load('local'); inner.connected = true
  const run = (id: string) => ({ runId: id, lifecycleOperationId: null, program: 'claude', args: [], workspacePath: root,
    pid: id === 'old-run' ? null : 321, state: id === 'old-run' ? { type: 'exited', code: 0, signal: null } : { type: 'running' },
    cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0 })
  const start = vi.fn(async () => run('new-run')), stop = vi.fn(), input = vi.fn()
  Object.assign(inner.kernel, { isConnected: () => true, identity: () => ({ daemonInstanceId: 'private-daemon', protocolVersion: 18, buildIdentity: 'private-io' }),
    status: async (id: string) => run(id), start, stop, input })
  inner.hookServer.isRunning = () => true
  inner.hookServer.createBinding = () => ({ bindingId: 'b'.repeat(43), endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) }, bindRun: async () => {}, close: async () => {} })
  vi.spyOn(core, 'probeAgent').mockImplementation(async id => ({ providerId: id, executable: id, installed: true,
    capabilities: new AgentProviderRegistry().get(id).catalog.capabilities }))
  inner.ensureManagedHooks = async () => {}; inner.ensureTerminalHandshakeOrDegrade = async (session: AgentMuxAgentSession) => session
  const prompt = '  Original <User> & &amp;\r\nKeep final whitespace.  \n', agentMuxNote = 'Runtime context <literal>\r\nPlatform only.'
  try {
    const resumed = await core.resumeAgent({ agentSessionId: previous.agentSessionId, operationId: 'original-resume', prompt, agentMuxNote })
    expect(resumed.run).toEqual({ runId: 'new-run' }); expect(resumed.nativeHandle).toEqual(previous.nativeHandle)
    expect(start).toHaveBeenCalledTimes(1)
    expect(start.mock.calls[0]![0].args).toContain(composeAgentPrompt(prompt, agentMuxNote).text)
    expect((await new AgentMuxFileAgentSessionStore(store.path).loadTimeline(previous.agentSessionId)).items.map(item => [item.kind, item.source, item.content])).toEqual([
      ['system_message', 'agentmux', agentMuxNote], ['user_message', 'user', prompt]
    ])
    expect(stop.mock.calls).toEqual([]); expect(input.mock.calls).toEqual([])
  } finally { await core.dispose(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) }
})
