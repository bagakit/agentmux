import { describe, expect, it, vi } from 'vitest'
import { mintAgentSessionId, resolveAgentSessionId } from '../src/agent-session-id.js'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

describe('canonical Agent Session identity', () => {
  it('uses all 96 random bits with the same browser-safe canonical format', () => {
    const entropy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((array) => {
      expect(array).toBeInstanceOf(Uint8Array)
      expect(array?.byteLength).toBe(12)
      ;(array as Uint8Array).set([0, 1, 2, 3, 4, 5, 6, 7, 8, 253, 254, 255])
      return array
    })
    try {
      expect(mintAgentSessionId()).toBe('AAECAwQFBgcI_f7_')
      expect(entropy).toHaveBeenCalledTimes(1)
    } finally { entropy.mockRestore() }
  })

  it('mints distinct short canonical IDs', () => {
    const ids = Array.from({ length: 1000 }, () => mintAgentSessionId())
    expect(ids).toHaveLength(1000)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/u)
  })

  it('prefers exact identity, rejects collisions, and never guesses an unknown prefix', () => {
    const known = ['agent', 'agent-two', 'unique-id']
    expect(resolveAgentSessionId('agent', known)).toBe('agent')
    expect(resolveAgentSessionId('unique', known)).toBe('unique-id')
    expect(() => resolveAgentSessionId('age', known)).toThrowError(expect.objectContaining({ code: 'AMBIGUOUS_AGENT_SESSION' }))
    expect(() => resolveAgentSessionId('missing', known)).toThrowError(expect.objectContaining({ code: 'UNKNOWN_AGENT_SESSION' }))
    expect(() => resolveAgentSessionId('', known)).toThrowError(expect.objectContaining({ code: 'UNKNOWN_AGENT_SESSION' }))
  })

  it('public Core creation passes the compact canonical identity to its lifecycle reservation', async () => {
    const client = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() })
    const internals = client as unknown as { connected: boolean; kernel: { isConnected(): boolean }; registry: { reserveNew(id: string, operationId: string): Promise<never> } }
    internals.connected = true
    internals.kernel.isConnected = () => true
    const reserved: string[] = []
    internals.registry.reserveNew = async (id) => { reserved.push(id); throw new Error('reservation reached') }
    try {
      await expect(client.createAgent({ executorId: 'codex', providerId: 'codex', workspacePath: '/repo', injectAgentMuxGuide: false })).rejects.toThrow('reservation reached')
      expect(reserved).toHaveLength(1)
      expect(reserved[0]).toMatch(/^[A-Za-z0-9_-]{16}$/u)
    } finally { await client.dispose() }
  })

  it('Core respawn mints a new canonical identity while preserving the previous durable long identity', async () => {
    const store = new AgentMuxMemoryAgentSessionStore()
    const previous: AgentMuxStoredAgentSession = {
      kind: 'agent', agentSessionId: '765ae7ef-b886-4681-b9b5-0bbc561e8f1a', providerId: 'codex', executorId: 'codex',
      hostId: 'local', workspacePath: '/repo', run: { runId: 'previous-run' }, retiredRuns: [],
      hookBindingId: 'hook', hookToken: 'token', outputCursorBytes: 0, createdAt: 1, updatedAt: 1
    }
    await store.compareAndSwap(null, previous)
    const client = new AgentMuxClient({ store })
    await (client as unknown as { registry: { load(hostId: string): Promise<void> } }).registry.load('local')
    const create = vi.spyOn(client, 'createAgent').mockImplementation(async (input) => ({ ...previous, agentSessionId: input.agentSessionId! }))
    try {
      const next = await client.respawnAgent({ previousAgentSessionId: previous.agentSessionId, injectAgentMuxGuide: false })
      expect(create).toHaveBeenCalledTimes(1)
      expect(next.agentSessionId).toMatch(/^[A-Za-z0-9_-]{16}$/u)
      expect(next.agentSessionId).not.toBe(previous.agentSessionId)
      expect(client.agentSession(previous.agentSessionId).agentSessionId).toBe(previous.agentSessionId)
    } finally { await client.dispose() }
  })
})
