import { describe, expect, it } from 'vitest'
import { AgentExecutionBridge, type AgentExecutionBridgePort, type AgentExecutionBridgeState } from '../src/agent-execution-bridge.js'
import type { AgentMuxClientEvent, AgentMuxRunInputOperation } from '../src/types.js'

function port(runId: string, output: string, options: { replayChunkBytes?: number; replayEndByte?: number; liveDuringAttach?: { startByte: number; data: string }[] } = {}) {
  let listener: ((event: AgentMuxClientEvent) => unknown) | undefined
  const writes: AgentMuxRunInputOperation[] = [], targets: string[] = []
  const claimed = new Map<string, { startByte: number; endByte: number }>()
  let cursor = 0, loseAck = false, gap = false, runtime = 'runtime', replayFault: 'none' | 'tamper' | 'truncated' = 'none'
  const replayReads: { runId: string; after: number; surface: string }[] = []
  const emit = (startByte: number, data: string) => listener?.({ type: 'terminal-output', run: { runId }, data, dataBytes: Buffer.from(data),
    evidence: { source: 'terminal-output', observedAt: 0, run: { runId }, outputByteRange: { startByte, endByte: startByte + Buffer.byteLength(data) } } } as AgentMuxClientEvent)
  const api = {
    runtimeIdentity: () => ({ instanceId: runtime }),
    onRunEvent: (target: string, fn: typeof listener) => { expect(target).toBe(runId); listener = fn; return () => { listener = undefined } },
    attachTerminal: async (_run: string, after: number) => {
      const bytes = Buffer.from(output), end = options.replayEndByte ?? bytes.length, replay = []
      for (let at = after; at < end; at += options.replayChunkBytes ?? end) {
        const through = Math.min(end, at + (options.replayChunkBytes ?? end))
        replay.push({ startByte: at, endByte: through, dataBytes: bytes.subarray(at, through) })
      }
      for (const event of options.liveDuringAttach ?? []) emit(event.startByte, event.data)
      return { run: { runId, state: 'running' }, gap: gap ? {} : null, replay }
    },
    readRunReplay: async (target: { runId: string }, after: number, surface: string) => {
      replayReads.push({ ...target, after, surface })
      if (target.runId !== runId) throw new Error('Replay was read from a replacement Run')
      const bytes = Buffer.from(output), replay = []
      if (replayFault === 'tamper') bytes[bytes.length - 2] = 88
      const end = bytes.length - (replayFault === 'truncated' ? 1 : 0)
      for (let at = after; at < end; at += options.replayChunkBytes ?? end) {
        const through = Math.min(end, at + (options.replayChunkBytes ?? end))
        replay.push({ startByte: at, endByte: through, dataBytes: bytes.subarray(at, through) })
      }
      return { run: { runId, state: 'running' }, gap: gap ? {} : null, replay }
    },
    releaseRunAttachment: async () => {},
    writeTerminal: async (target: { runId: string }, operation: AgentMuxRunInputOperation) => {
      targets.push(target.runId)
      if (target.runId !== runId) throw new Error('The original Input was retargeted to another Run')
      writes.push(structuredClone(operation))
      let range = claimed.get(operation.operationId)
      if (!range) {
        expect(operation.expectedByte).toBe(cursor)
        const bytes = typeof operation.data === 'string' ? Buffer.byteLength(operation.data) : operation.data.byteLength
        range = { startByte: cursor, endByte: cursor + bytes }; cursor += bytes
        claimed.set(operation.operationId, range)
      }
      if (loseAck) { loseAck = false; throw new Error('original acknowledgement lost') }
      return { runId, appliedByteRange: range, acceptedThroughByte: cursor }
    },
  } as unknown as AgentExecutionBridgePort
  return { api, writes, targets, claimed, replayReads, replayFault: (value: typeof replayFault) => { replayFault = value }, runtime: (value: string) => { runtime = value }, loseAck: () => { loseAck = true }, gap: () => { gap = true },
    emit }
}
const state = (): AgentExecutionBridgeState => ({ bindingId: 'binding',
  frontend: { runId: 'front', ownerInstanceId: 'runtime', inputByte: 0, outputByte: 0 },
  executor: { runId: 'exec', ownerInstanceId: 'runtime', inputByte: 0, outputByte: 0 } })
const inputText = (data: AgentMuxRunInputOperation['data']): string => typeof data === 'string' ? data : Buffer.from(data).toString()
const request = '  ' + JSON.stringify({ type: 'request', generation: 'original', payload: { id: 1, method: 'write', params: { text: '中文' } } }) + ' \n'

describe('execution bridge original Runtime continuation', () => {
  it('forwards the original frame through the public recoverable Input and saves its exact receipt', async () => {
    const f = port('front', request), e = port('exec', '')
    let saved = state()
    const bridge = new AgentExecutionBridge({ state: saved, ports: { frontend: f.api, executor: e.api },
      persist: async next => { saved = structuredClone(next) }, onFrame: async () => {}, onError: error => { throw error } })
    await bridge.start()
    expect(e.writes).toHaveLength(1)
    expect(e.targets).toEqual(['exec'])
    expect(inputText(e.writes[0]!.data)).toBe(request)
    expect(saved.frontend.outputByte).toBe(Buffer.byteLength(request))
    expect(saved.executor.inputByte).toBe(Buffer.byteLength(request))
    expect(saved.pending).toBeUndefined()
    await bridge.close()
  })
  it('rejoins the same native Input operation after a lost acknowledgement, never creates a second effect', async () => {
    const f = port('front', request), e = port('exec', '')
    let saved = state()
    const options = { ports: { frontend: f.api, executor: e.api }, persist: async (next: AgentExecutionBridgeState) => { saved = structuredClone(next) }, onFrame: async () => {}, onError: () => {} }
    e.loseAck()
    const first = new AgentExecutionBridge({ ...options, state: saved })
    await expect(first.start()).rejects.toThrow()
    expect(saved.pending).toBeDefined()
    expect(saved.pending!.operation).not.toHaveProperty('data')
    expect(Object.keys(saved.pending!.operation).sort()).toEqual(['expectedByte', 'operationId', 'ownerInstanceId'])
    expect(JSON.stringify(saved.pending)).not.toContain('中文')
    expect(saved.pending!.sourceStartByte).toBe(0)
    expect(saved.pending!.sourceEndByte).toBe(Buffer.byteLength(request))
    const original = structuredClone(e.writes[0])
    await first.close()
    const second = new AgentExecutionBridge({ ...options, state: saved })
    await second.start()
    expect(e.writes).toEqual([original, original])
    expect(e.targets).toEqual(['exec', 'exec'])
    expect(f.replayReads).toEqual([{ runId: 'front', after: 0, surface: 'raw' }])
    expect(e.claimed.size).toBe(1)
    expect(saved.pending).toBeUndefined()
    await second.close()
  })
  it('does not dispatch when the original pending Input has not been durably recorded', async () => {
    const f = port('front', request), e = port('exec', '')
    const bridge = new AgentExecutionBridge({ state: state(), ports: { frontend: f.api, executor: e.api },
      persist: async () => { throw new Error('disk unavailable') }, onFrame: async () => {}, onError: () => {} })
    await expect(bridge.start()).rejects.toThrow()
    expect(e.writes).toHaveLength(0)
    await bridge.close()
  })
  it('keeps missing replay unknown instead of forwarding a suffix as a new protocol', async () => {
    const f = port('front', request), e = port('exec', ''); f.gap()
    const bridge = new AgentExecutionBridge({ state: state(), ports: { frontend: f.api, executor: e.api },
      persist: async () => {}, onFrame: async () => {}, onError: () => {} })
    await expect(bridge.start()).rejects.toThrow(/Gap/)
    expect(e.writes).toHaveLength(0)
    await bridge.close()
  })
  it('trims authoritative partial replay/live overlap across different chunk boundaries exactly once', async () => {
    const split = 23
    const f = port('front', request, { replayEndByte: split, replayChunkBytes: 7, liveDuringAttach: [{ startByte: 0, data: request }] }), e = port('exec', '')
    let saved = state()
    const errors: Error[] = []
    const bridge = new AgentExecutionBridge({ state: saved, ports: { frontend: f.api, executor: e.api },
      persist: async next => { saved = structuredClone(next) }, onFrame: async () => {}, onError: error => { errors.push(error) } })
    try {
      await bridge.start()
      expect(errors).toEqual([])
      expect(e.writes.map(write => inputText(write.data))).toEqual([request])
      expect(saved.frontend.outputByte).toBe(Buffer.byteLength(request))
      expect(saved.executor.inputByte).toBe(Buffer.byteLength(request))
    } finally { await bridge.close() }
  })
  it('copies a multi-megabyte frame linearly when replay arrives in small PTY chunks', async () => {
    const large = JSON.stringify({ type: 'request', generation: 'original', payload: { id: 1, method: 'write', data: 'x'.repeat(2 * 1024 * 1024) } }) + '\n'
    const f = port('front', large, { replayChunkBytes: 4096 }), e = port('exec', '')
    const bridge = new AgentExecutionBridge({ state: state(), ports: { frontend: f.api, executor: e.api },
      persist: async () => {}, onFrame: async () => {}, onError: error => { throw error } })
    const concat = Buffer.concat
    let copiedBytes = 0
    Buffer.concat = (parts, length) => {
      copiedBytes += length ?? parts.reduce((sum, part) => sum + part.byteLength, 0)
      return concat(parts, length)
    }
    const started = performance.now()
    try {
      await bridge.start()
      expect(e.writes.map(write => inputText(write.data))).toEqual([large])
      expect(copiedBytes).toBeGreaterThanOrEqual(Buffer.byteLength(large) - 1)
      expect(copiedBytes).toBeLessThanOrEqual(Buffer.byteLength(large) * 2)
      console.info('execution bridge large-frame cost', { frameBytes: Buffer.byteLength(large), chunkBytes: 4096, copiedBytes, durationMs: performance.now() - started })
    } finally { Buffer.concat = concat; await bridge.close() }
  })
  it('retains the original pending Input when the Runtime owner changes instead of retargeting it', async () => {
    const f = port('front', request), e = port('exec', '')
    let saved = state()
    const options = { ports: { frontend: f.api, executor: e.api }, persist: async (next: AgentExecutionBridgeState) => { saved = structuredClone(next) }, onFrame: async () => {}, onError: () => {} }
    e.loseAck()
    const first = new AgentExecutionBridge({ ...options, state: saved })
    await expect(first.start()).rejects.toThrow(); await first.close()
    const pending = structuredClone(saved.pending)
    e.runtime('replacement-runtime')
    const second = new AgentExecutionBridge({ ...options, state: saved })
    try {
      await expect(second.start()).rejects.toMatchObject({ code: 'EXECUTION_RUNTIME_CHANGED' })
      expect(e.writes).toHaveLength(1)
      expect(e.targets).toEqual(['exec'])
      expect(saved.pending).toEqual(pending)
    } finally { await second.close() }
  })

  it.each([
    ['gap', 'EXECUTION_PROTOCOL_GAP'],
    ['tamper', 'EXECUTION_INPUT_SOURCE_MISMATCH'],
    ['truncated', 'EXECUTION_PROTOCOL_GAP'],
  ] as const)('retains the original pending claim without sending when source Replay has %s', async (fault, code) => {
    const f = port('front', request, { replayChunkBytes: 7 }), e = port('exec', '')
    let saved = state()
    const options = { ports: { frontend: f.api, executor: e.api }, persist: async (next: AgentExecutionBridgeState) => { saved = structuredClone(next) }, onFrame: async () => {}, onError: () => {} }
    e.loseAck()
    const first = new AgentExecutionBridge({ ...options, state: saved })
    await expect(first.start()).rejects.toThrow(); await first.close()
    const pending = structuredClone(saved.pending)
    if (fault === 'gap') f.gap(); else f.replayFault(fault)
    const second = new AgentExecutionBridge({ ...options, state: saved })
    try {
      await expect(second.start()).rejects.toMatchObject({ code })
      expect(e.writes).toHaveLength(1)
      expect(saved.pending).toEqual(pending)
      expect(f.replayReads).toEqual([{ runId: 'front', after: 0, surface: 'raw' }])
    } finally { await second.close() }
  })
  it('does not recover pending bytes from a replacement source Runtime even when the content matches', async () => {
    const f = port('front', request), e = port('exec', '')
    let saved = state()
    const options = { ports: { frontend: f.api, executor: e.api }, persist: async (next: AgentExecutionBridgeState) => { saved = structuredClone(next) }, onFrame: async () => {}, onError: () => {} }
    e.loseAck()
    const first = new AgentExecutionBridge({ ...options, state: saved })
    await expect(first.start()).rejects.toThrow(); await first.close()
    f.runtime('replacement-source-runtime')
    const second = new AgentExecutionBridge({ ...options, state: saved })
    try {
      await expect(second.start()).rejects.toMatchObject({ code: 'EXECUTION_RUNTIME_CHANGED' })
      expect(e.writes).toHaveLength(1)
      expect(f.replayReads).toHaveLength(0)
    } finally { await second.close() }
  })

})
