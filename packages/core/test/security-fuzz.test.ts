import { describe, expect, it } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentTerminalScreen } from '../src/agent-terminal-screen.js'
import { normalizeStoredAgentSession } from '../src/agent-session-store.js'
import { AgentMuxError } from '../src/errors.js'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000
  }
}

function integer(next: () => number, maximum: number): number {
  return Math.floor(next() * maximum)
}

function randomString(next: () => number): string {
  const alphabet = ['a', 'Z', '0', '-', '_', ' ', '\0', '\n', '\u001b', '中', '😀', '/', '.']
  return Array.from({ length: integer(next, 32) }, () => alphabet[integer(next, alphabet.length)]).join('')
}

function randomJson(next: () => number, depth = 0): Json {
  const kind = depth >= 3 ? integer(next, 4) : integer(next, 6)
  if (kind === 0) return null
  if (kind === 1) return next() >= 0.5
  if (kind === 2) return integer(next, 2_000_000) - 1_000_000
  if (kind === 3) return randomString(next)
  if (kind === 4) {
    return Array.from({ length: integer(next, 8) }, () => randomJson(next, depth + 1))
  }
  return Object.fromEntries(Array.from({ length: integer(next, 8) }, (_, index) => [
    `${randomString(next)}-${index}`,
    randomJson(next, depth + 1)
  ]))
}

describe('deterministic AgentMux boundary fuzz', () => {
  it('seed 0x41c6ce57 keeps Hook normalization total over bounded JSON values', () => {
    const next = random(0x41c6ce57)
    const providers = new AgentProviderRegistry()
    const ids = providers.catalog().map((entry) => entry.id)

    for (let index = 0; index < 1_000; index += 1) {
      const payload = randomJson(next)
      const agentId = ids[integer(next, ids.length)]!
      const normalized = providers.get(agentId).normalizeHook({
        receiptId: `receipt-${index}`,
        agentSessionId: `semantic-${index}`,
        runId: `run-${index}`,
        agentId,
        eventName: randomString(next),
        payload: payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : { value: payload }
      })

      expect(normalized.agentSessionId).toBe(`semantic-${index}`)
      expect(normalized.run).toEqual({ runId: `run-${index}` })
      expect(normalized.activities.length).toBeGreaterThan(0)
      if (normalized.nativeHandle?.kind === 'provider') {
        expect(Buffer.byteLength(normalized.nativeHandle.sessionId)).toBeLessThanOrEqual(512)
        expect(normalized.nativeHandle.sessionId).not.toMatch(/[\0-\x1f\x7f]/u)
      }
    }
  })

  it('seed 0x6f2a912d rejects arbitrary Store values only through the typed boundary', () => {
    const next = random(0x6f2a912d)
    let rejected = 0
    for (let index = 0; index < 1_000; index += 1) {
      try {
        normalizeStoredAgentSession(randomJson(next))
      } catch (error) {
        rejected += 1
        expect(error).toBeInstanceOf(AgentMuxError)
        expect((error as AgentMuxError).code).toBe('INVALID_AGENT_SESSION_STORE')
      }
    }
    expect(rejected).toBe(1_000)
  })

  it('seed 0xb70d4e19 accepts arbitrary terminal bytes under contiguous fragmentation', async () => {
    const next = random(0xb70d4e19)
    for (let sample = 0; sample < 64; sample += 1) {
      const screen = new AgentTerminalScreen(80, 24)
      try {
        const bytes = Uint8Array.from(
          { length: 1 + integer(next, 512) },
          () => integer(next, 256)
        )
        let offset = 0
        while (offset < bytes.byteLength) {
          const length = Math.min(bytes.byteLength - offset, 1 + integer(next, 31))
          const fragment = bytes.slice(offset, offset + length)
          await screen.write({
            startByte: offset,
            endByte: offset + fragment.byteLength,
            dataBytes: fragment
          })
          offset += fragment.byteLength
        }
        expect(screen.throughByte).toBe(bytes.byteLength)
        expect(() => screen.composerText('›')).not.toThrow()
      } finally {
        screen.dispose()
      }
    }
  })
})
