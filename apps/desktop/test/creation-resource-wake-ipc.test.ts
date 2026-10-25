// @vitest-environment happy-dom
// Real Core creation/wait + RuntimeController + registered IPC + preload. Native start is
// deliberately never reached; the independent restart proof owns successful PTY creation.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxMemoryAgentSessionStore, AgentMuxError } from '@agentmux/core'
import { bridge, owningBridge } from './fixtures/terminal-observation-bridge'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { isolateCoreFixtureEnvironment } from './helpers/isolate-core-environment'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
it('actual preload and trusted Main wake the same live Core creation without reconnecting or replacing its request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-creation-wake-ipc-'))
  isolateCoreFixtureEnvironment(root)
  let attempts = 0, release = false
  const store = new AgentMuxMemoryAgentSessionStore()
  const core = new AgentMuxClient({ store, prepareExecutionEnvironment: async () => {
    attempts++
    if (!release) throw Object.assign(new Error('ENOSPC: private preparation storage'), { code: 'ENOSPC' })
    throw new AgentMuxError('Private proof stops before Native start', 'PRIVATE_PROOF_COMPLETE')
  } })
  const inner = core as any
  inner.connected = true
  vi.spyOn(inner.kernel, 'isConnected').mockReturnValue(true)
  await inner.registry.load('local')
  const connect = vi.spyOn(core, 'connect'), start = vi.spyOn(inner.kernel, 'start')
  const original = { hostId: 'local', agentSessionId: 'original-private-session', createOperationId: 'original-private-creation' }
  const b = await owningBridge({ client: core, store, config: { ...structuredClone(DEFAULT_CONFIG), executors: {} } })
  const events: any[] = []
  let waiting!: () => void
  const waitObserved = new Promise<void>(resolve => { waiting = resolve })
  const unsubscribe = core.onEvent(event => { events.push(event); if (event.type === 'agent-error' && event.code === 'AGENT_CREATION_WAITING_FOR_STORAGE') waiting() })
  let pending: ReturnType<typeof core.createAgentWithDelivery> | undefined
  try {
    pending = core.createAgentWithDelivery({ ...original, providerId: 'codex', executorId: 'codex', workspacePath: root,
      prompt: 'Untouched original prompt', injectAgentMuxGuide: false })
    void pending.catch(() => {})
    await Promise.race([waitObserved, pending.then(() => { throw new Error('Expected resource wait before completion') })])
    const handler = bridge.handlers.get('sessions:continueCreation')!
    await expect(handler({ sender: {} }, original)).rejects.toThrow('Untrusted original creation continuation sender')
    await expect(bridge.api!.sessions.continueCreation({ ...original, hostId: 'foreign-host' })).rejects.toThrow('not configured')
    await expect(bridge.api!.sessions.continueCreation({ ...original, agentSessionId: 'wrong-session' })).rejects.toThrow('another Session')
    await expect(bridge.api!.sessions.continueCreation({ ...original, createOperationId: 'foreign-creation' })).resolves.toEqual({ hostId: 'local', createOperationId: 'foreign-creation', status: 'unknown' })
    expect(attempts).toBe(1)
    release = true
    await expect(bridge.api!.sessions.continueCreation(original)).resolves.toEqual({ ...original, status: 'woken' })
    await expect(pending).rejects.toThrow('Private proof stops before Native start')
    expect(attempts).toBe(2)
    expect(events.some(event => event.code === 'AGENT_CREATION_RESOURCE_RETRY_STOPPED')).toBe(true)
    expect(connect).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled()
    await expect(bridge.api!.sessions.continueCreation(original)).resolves.toEqual({ hostId: 'local', createOperationId: original.createOperationId, status: 'unknown' })
    const method = vi.spyOn(core, 'continueAgentCreation')
    method.mockResolvedValueOnce({ createOperationId: 'foreign-creation', agentSessionId: original.agentSessionId, status: 'woken' })
    await expect(bridge.api!.sessions.continueCreation(original)).rejects.toThrow()
    method.mockResolvedValueOnce({ createOperationId: original.createOperationId, agentSessionId: 'foreign-session', status: 'woken' })
    await expect(bridge.api!.sessions.continueCreation(original)).rejects.toThrow()
  } finally {
    for (const entry of inner.activeCreations.values()) entry.controller.abort()
    await pending?.catch(() => {})
    unsubscribe(); await b.dispose(); await core.dispose(); await rm(root, { recursive: true, force: true })
  }
}, 30000)
