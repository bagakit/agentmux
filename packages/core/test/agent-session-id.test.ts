import { fixturePath } from './helpers/fixture-values.js'
import { describe, expect, it, vi } from 'vitest'
import { deriveAgentSessionId, mintAgentSessionId, resolveAgentSessionId } from '../src/agent-session-id.js'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

describe('canonical Agent Session identity', () => {
  it('derives stable creation IDs in the complete canonical space', async () => {
    const ids = await Promise.all(['operation-a', 'operation-b', 'Operation-a'].map(deriveAgentSessionId))
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(3)
    for (const id of ids) expect(id).toMatch(/^[1-9A-HJ-NP-Za-km-z]{17}$/u)
    expect(await deriveAgentSessionId('operation-a')).toBe(ids[0])
  })
  it.each([
    { bytes: Array(12).fill(0), expected: '11111111111111111' },
    { bytes: [...Array(11).fill(0), 1], expected: '11111111111111112' },
    { bytes: [...Array(11).fill(0), 58], expected: '11111111111111121' },
    { bytes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 253, 254, 255], expected: '111FVk6iLh9oUWgRU' },
    { bytes: Array(12).fill(255), expected: '5qCHTcgbQwpvYZQ9c' }
  ])('preserves complete entropy with exactly 17 Base58 characters: $expected', ({ bytes, expected }) => {
    const entropy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(array => {
      expect(array).toBeInstanceOf(Uint8Array)
      expect(array?.byteLength).toBe(12)
      ;(array as Uint8Array).set(bytes)
      return array
    })
    try {
      expect(mintAgentSessionId()).toBe(expected)
      expect(entropy).toHaveBeenCalledTimes(1)
    } finally { entropy.mockRestore() }
  })

  it.each([
    { byte: 0, expected: '11111111111111111' },
    { byte: 255, expected: '5qCHTcgbQwpvYZQ9c' }
  ])('keeps deterministic IDs equally wide at the digest boundaries: $byte', async ({ byte, expected }) => {
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest').mockResolvedValue(new Uint8Array(32).fill(byte).buffer)
    try { expect(await deriveAgentSessionId('boundary-operation')).toBe(expected) }
    finally { digest.mockRestore() }
  })

  it('mints distinct short canonical IDs', () => {
    const ids = Array.from({ length: 1000 }, () => mintAgentSessionId())
    expect(ids).toHaveLength(1000)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[1-9A-HJ-NP-Za-km-z]{17}$/u)
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
      await expect(client.createAgent({ executorId: 'codex', providerId: 'codex', workspacePath: fixturePath("repo"), injectAgentMuxGuide: false })).rejects.toThrow('reservation reached')
      expect(reserved).toHaveLength(1)
      expect(reserved[0]).toMatch(/^[1-9A-HJ-NP-Za-km-z]{17}$/u)
    } finally { await client.dispose() }
  })

  it.each(['SCzGtBarRkQBz3b-', '765ae7ef-b886-4681-b9b5-0bbc561e8f1a', '11111111111111111'])(
    'keeps an explicitly supplied original identity %s before reservation', async agentSessionId => {
      const client = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() })
      const internals = client as unknown as { connected: boolean; kernel: { isConnected(): boolean }; registry: { reserveNew(id: string, operationId: string): Promise<never> } }
      internals.connected = true
      internals.kernel.isConnected = () => true
      const reserve = vi.fn(async () => { throw new Error('reservation reached') })
      internals.registry.reserveNew = reserve
      const entropy = vi.spyOn(globalThis.crypto, 'getRandomValues')
      try {
        await expect(client.createAgent({ agentSessionId, executorId: 'codex', providerId: 'codex', workspacePath: fixturePath("repo"), injectAgentMuxGuide: false })).rejects.toThrow('reservation reached')
        expect(reserve).toHaveBeenCalledExactlyOnceWith(agentSessionId, expect.any(String))
        expect(entropy).not.toHaveBeenCalled()
      } finally { entropy.mockRestore(); await client.dispose() }
    }
  )

  it.each(['', '-forbidden', '_forbidden', 'invalid/session', 'invalid.id', 'x'.repeat(129)])(
    'keeps invalid external identity %j rejected before lifecycle reservation', async agentSessionId => {
      const client = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() })
      const internals = client as unknown as { connected: boolean; kernel: { isConnected(): boolean };
        registry: { reserveNew(id: string, operationId: string): Promise<never> } }
      internals.connected = true
      internals.kernel.isConnected = () => true
      const reserve = vi.fn<(...args: string[]) => Promise<never>>()
      internals.registry.reserveNew = reserve
      const entropy = vi.spyOn(globalThis.crypto, 'getRandomValues')
      try {
        await expect(client.createAgent({ agentSessionId, executorId: 'codex', providerId: 'codex',
          workspacePath: fixturePath("repo"), injectAgentMuxGuide: false })).rejects.toThrowError(expect.objectContaining({ code: 'INVALID_SESSION_ID' }))
        expect(reserve).not.toHaveBeenCalled()
        expect(entropy).not.toHaveBeenCalled()
      } finally { entropy.mockRestore(); await client.dispose() }
    }
  )

  it('Core respawn mints a new canonical identity while preserving the previous durable long identity', async () => {
    const store = new AgentMuxMemoryAgentSessionStore()
    const previous: AgentMuxStoredAgentSession = {
      kind: 'agent', agentSessionId: '765ae7ef-b886-4681-b9b5-0bbc561e8f1a', providerId: 'codex', executorId: 'codex',
      hostId: 'local', workspacePath: fixturePath("repo"), run: { runId: 'previous-run' }, retiredRuns: [],
      hookBindingId: 'hook', hookToken: 'token',  createdAt: 1, updatedAt: 1
    }
    await store.compareAndSwap(null, previous)
    const client = new AgentMuxClient({ store })
    await (client as unknown as { registry: { load(hostId: string): Promise<void> } }).registry.load('local')
    const create = vi.spyOn(client, 'createAgent').mockImplementation(async (input) => ({ ...previous, agentSessionId: input.agentSessionId! }))
    try {
      const next = await client.respawnAgent({ previousAgentSessionId: previous.agentSessionId, injectAgentMuxGuide: false })
      expect(create).toHaveBeenCalledTimes(1)
      expect(next.agentSessionId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{17}$/u)
      expect(next.agentSessionId).not.toBe(previous.agentSessionId)
      expect(client.agentSession(previous.agentSessionId).agentSessionId).toBe(previous.agentSessionId)
    } finally { await client.dispose() }
  })
})
