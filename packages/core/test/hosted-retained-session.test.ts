import { fixturePath as upstreamFixturePath } from './helpers/fixture-values.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { issueAgentCapability, hashAgentCapability } from '../src/agent-capability.js'
import { cloneSession } from '../src/agent-session-identity.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import type { AgentMuxHostedRpcPort } from '../src/hosted-client-contract.js'
import type { AgentMuxClientEvent, AgentMuxStoredAgentSession } from '../src/types.js'

async function fixture(loadRegistry = false) {
  const directory = await mkdtemp(join(tmpdir(), 'amx-hosted-retained-'))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(directory, 'runtime'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(directory, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(directory, 'messages.ndjson'))
  const store = new AgentMuxMemoryAgentSessionStore(), capability = issueAgentCapability()
  const retained: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'a123456789012345',
    providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: directory,
    run: { runId: 'original-retained-run' }, retiredRuns: [], hookBindingId: 'private-binding',
    hookToken: 'private-hook-token', capabilityHash: hashAgentCapability(capability), createdAt: 1, updatedAt: 1 }
  await store.compareAndSwap(null, retained)
  const core = new AgentMuxClient({ providers: [], store })
  const registry = new AgentMuxAgentSessionRegistry(store)
  if (loadRegistry) await registry.load('local')
  let stopped = false
  const run = { runId: retained.run.runId, lifecycleOperationId: null, program: upstreamFixturePath("private-controlled-agent"), args: [],
    workspacePath: directory, pid: 421, cols: 80, rows: 24, latestOutputBytes: 0,
    firstAvailableByte: 0, acceptedInputBytes: 0 }
  // Core's Store, registry, authorization, stop methods and event publisher stay real.
  // No process is started: only the ctxmux collaborator's exact private receipts are controlled.
  const kernel = { isConnected: () => true, disconnect: vi.fn(),
    identity: () => ({ buildIdentity: 'private-ctxmux', protocolVersion: 1, daemonInstanceId: 'private-daemon' }),
    list: vi.fn(async () => [{ ...run, state: stopped ? { type: 'exited' as const, exitCode: 0 } : { type: 'running' as const } }]),
    status: vi.fn(async () => ({ ...run, state: stopped ? { type: 'exited' as const, exitCode: 0 } : { type: 'running' as const } })),
    prepareStop: vi.fn(async (runId: string) => ({ daemonInstance: 'private-daemon', operationKey: 'private-stop', runId })),
    stop: vi.fn(async () => { stopped = true }), detach: vi.fn(async () => {}) }
  Object.assign(core, { registry, kernel, connected: loadRegistry })
  const connect = vi.spyOn(core, 'connect').mockImplementation(async () => {
    if (!loadRegistry) throw new AgentMuxError('Private Runtime connection is unavailable.', 'CTXMUX_DISCONNECTED')
  })
  const service = new AgentMuxHostedRuntimeService(core, join(directory, 'sessions.json'))
  const port = {
    call: async (method: string, params: unknown, options?: { signal?: AbortSignal }) =>
      JSON.parse(JSON.stringify(await service.call(method, JSON.parse(JSON.stringify(params)), options))),
    subscribe: async (method: string, params: unknown, handlers: Parameters<AgentMuxHostedRpcPort['subscribe']>[2]) => {
      const stream = await service.subscribe(method, params, event => handlers.onEvent(JSON.parse(JSON.stringify(event))), { signal: handlers.signal })
      handlers.onInitial(JSON.parse(JSON.stringify(stream.initial)))
      return { dispose: async () => { await stream.dispose() } }
    }
  } as AgentMuxHostedRpcPort
  const client = await connectHostedAgentMux({ rpc: port })
  return { core, store, service, client, connect, capability, retained, kernel,
    dispose: async () => {
      await client.dispose(); await service.dispose(); await core.dispose()
      vi.unstubAllEnvs(); await rm(directory, { recursive: true })
    } }
}

describe('Hosted durable Session authority', () => {
  it('reads original durable Sessions through the finite SDK without replacing an empty live registry or requiring Runtime recovery', async () => {
    const f = await fixture()
    try {
      expect(f.core.agentSessions()).toEqual([])
      expect(f.client.agentSessions()).toEqual([])
      const connectCalls = f.connect.mock.calls.length
      expect(connectCalls).toBe(1)
      const original = cloneSession(f.retained)
      await expect(f.client.readAgentSessions()).resolves.toEqual([original])
      const changed = { ...f.retained, updatedAt: 2, workspacePath: join(f.retained.workspacePath, 'new-directory') }
      await f.store.compareAndSwap(f.retained, changed)
      await expect(f.client.readAgentSessions()).resolves.toEqual([cloneSession(changed)])
      expect(f.core.agentSessions()).toEqual([])
      expect(f.client.agentSessions()).toEqual([])
      expect(f.connect.mock.calls).toHaveLength(connectCalls)
      expect(f.kernel.stop.mock.calls).toEqual([])
      expect(f.kernel.list.mock.calls).toEqual([])
      expect(f.kernel.detach.mock.calls).toEqual([])
    } finally { await f.dispose() }
  })

  it('validates the original capability against the current durable Session on every finite call, including rotation and retirement while offline', async () => {
    const f = await fixture()
    try {
      await expect(f.client.authorizeRetainedAgentCaller(f.capability, f.retained.agentSessionId)).resolves.toEqual(cloneSession(f.retained))
      const rotated = issueAgentCapability()
      const changed = { ...f.retained, capabilityHash: hashAgentCapability(rotated), updatedAt: 2 }
      await f.store.compareAndSwap(f.retained, changed)
      await expect(f.client.authorizeRetainedAgentCaller(f.capability, f.retained.agentSessionId)).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
      await expect(f.client.authorizeRetainedAgentCaller(rotated, f.retained.agentSessionId)).resolves.toEqual(cloneSession(changed))
      await f.store.compareAndSwap(changed, null)
      await expect(f.client.authorizeRetainedAgentCaller(rotated, f.retained.agentSessionId)).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
      expect(f.connect).toHaveBeenCalledTimes(1)
      expect(f.kernel.stop.mock.calls).toEqual([])
      expect(f.kernel.list.mock.calls).toEqual([])
      expect(f.kernel.detach.mock.calls).toEqual([])
    } finally { await f.dispose() }
  })

  it('retains the Session after actual Core.stopTerminal and removes it only after actual Core.stopAgent commits retirement', async () => {
    const f = await fixture(true), events: AgentMuxClientEvent[] = []
    f.client.onEvent(event => events.push(event))
    try {
      const original = cloneSession(f.retained)
      expect(f.client.agentSessions()).toEqual([original])
      await f.client.stopTerminal(f.retained.run)
      expect(events.filter(event => event.type === 'run-removed')).toEqual([
        { type: 'run-removed', run: f.retained.run, evidence: { source: 'user', observedAt: expect.any(Number), run: f.retained.run } }
      ])
      expect(f.core.agentSessions()).toEqual([original])
      await expect(f.core.readAgentSessions()).resolves.toEqual([original])
      expect(f.client.agentSessions()).toEqual([original])
      expect(f.client.agentSession(f.retained.agentSessionId)).toEqual(original)
      await f.client.stopAgent(f.retained.agentSessionId, f.retained.run)
      expect(events.filter(event => event.type === 'run-removed')).toEqual([
        { type: 'run-removed', run: f.retained.run, evidence: { source: 'user', observedAt: expect.any(Number), run: f.retained.run } },
        { type: 'run-removed', agentSessionId: f.retained.agentSessionId, run: f.retained.run,
          evidence: { source: 'user', observedAt: expect.any(Number), run: f.retained.run } }
      ])
      expect(f.core.agentSessions()).toEqual([])
      await expect(f.core.readAgentSessions()).resolves.toEqual([])
      expect(f.client.agentSessions()).toEqual([])
      expect(() => f.client.agentSession(f.retained.agentSessionId)).toThrow(expect.objectContaining({ code: 'UNKNOWN_AGENT_SESSION' }))
      expect(f.kernel.stop).toHaveBeenCalledExactlyOnceWith({ daemonInstance: 'private-daemon', operationKey: 'private-stop', runId: f.retained.run.runId })
      await expect(f.store.loadRetiredAgentSessions()).resolves.toEqual([
        expect.objectContaining({ agentSessionId: f.retained.agentSessionId, run: f.retained.run, source: 'user' })
      ])
    } finally { await f.dispose() }
  })
})
