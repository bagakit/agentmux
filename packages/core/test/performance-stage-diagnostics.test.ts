import { fixturePath } from './helpers/fixture-values.js'
import { describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { createInputPerformanceRecorder } from '../src/performance-diagnostics.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
describe('process-local input diagnostics', () => {
  it('keeps bounded detached evidence, stage times and all category counts without input bodies', async () => {
    let ms = 0
    const recorder = createInputPerformanceRecorder(() => ms, () => 1000 + ms)
    const handles = Array.from({ length: 100 }, (_, i) => recorder.begin({ sessionId: 'session', runId: `run-${i}`,
      kind: i % 2 ? 'protocol' : 'paste', bytes: i }))
    expect(recorder.snapshot()).toMatchObject({ pending: 100, omittedActive: 36, kinds: { protocol: 50, paste: 50 } })
    expect(recorder.snapshot().active).toHaveLength(64)
    ms = 20; handles[0]!.dequeue()
    await handles[0]!.measure('current-run', async () => { ms += 30 })
    await expect(handles[0]!.measure('native-input', async () => { ms += 40; throw new Error('original failure') })).rejects.toThrow('original failure')
    handles.forEach((handle, i) => handle.settle(i !== 0))
    const facts = recorder.snapshot()
    expect(facts).toMatchObject({ started: 100, pending: 0, completed: 99, failed: 1, omittedRecent: 68,
      queueWait: { maxMs: 20 }, currentRun: { maxMs: 30 }, nativeInput: { maxMs: 40 } })
    expect(facts.recent).toHaveLength(32)
    facts.queueWait.maxMs = 0; facts.kinds.paste = 0; facts.recent[0]!.runId = 'mutated'
    expect(recorder.snapshot().queueWait.maxMs).toBe(20)
    expect(recorder.snapshot().kinds.paste).toBe(50)
    expect(recorder.snapshot().recent[0]!.runId).toBe('run-68')
    expect(JSON.stringify(recorder.snapshot())).not.toContain('original failure')
  })

  it('observes actual Core FIFO status/native phases, preserves ordered bytes and errors, and never connects for reads', async () => {
    const stored: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'diagnostic-session', providerId: 'codex', executorId: 'codex',
      hostId: 'local', workspacePath: fixturePath("synthetic"), run: { runId: 'diagnostic-run' }, retiredRuns: [], hookBindingId: 'synthetic-binding',
      hookToken: 'synthetic-token', createdAt: 1, updatedAt: 2 }
    const store = new AgentMuxMemoryAgentSessionStore(); await store.compareAndSwap(null, stored)
    const client = new AgentMuxClient({ store })
    const inner = client as any
    const connect = vi.spyOn(client, 'connectRuntime')
    expect((await client.clientPerformanceDiagnostics()).input.started).toBe(0)
    expect(connect).not.toHaveBeenCalled()
    await inner.registry.load('local'); inner.connected = true; inner.kernel.isConnected = () => true
    inner.kernel.identity = () => ({ daemonInstanceId: 'synthetic-daemon' })
    let accepted = 0
    const run = () => ({ nativeService: null, runId: 'diagnostic-run', lifecycleOperationId: null, program: 'codex', args: [],
      workspacePath: fixturePath("synthetic"), pid: 123, state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0,
      firstAvailableByte: 0, acceptedInputBytes: accepted })
    const status = deferred<void>(), native = deferred<void>(), sent: string[] = []
    let statusCalls = 0
    inner.kernel.status = async () => { if (++statusCalls === 1) await status.promise; return run() }
    inner.kernel.input = async (_id: string, input: { data: string; expectedByte: number }) => {
      sent.push(input.data)
      if (sent.length === 1) await native.promise
      if (input.data === 'failure') throw new Error('native rejection')
      expect(input.expectedByte).toBe(accepted)
      const start = accepted; accepted += Buffer.byteLength(input.data)
      return { run: run(), appliedByteRange: { startByte: start, endByte: accepted } }
    }
    try {
      const one = client.writeAgent({ agentSessionId: stored.agentSessionId, expectedRun: stored.run, data: 'first', source: 'user' })
      const two = client.writeAgent({ agentSessionId: stored.agentSessionId, expectedRun: stored.run, data: '\u001b[1;2R', source: 'terminal-protocol' })
      await flush()
      const waiting = (await client.clientPerformanceDiagnostics()).input
      expect(waiting.active.map(item => item.stage)).toEqual(['current-run', 'queued'])
      expect(waiting.kinds).toMatchObject({ user: 1, protocol: 1 })
      expect(sent).toEqual([])
      status.resolve(); await flush()
      expect((await client.clientPerformanceDiagnostics()).input.active[0]?.stage).toBe('native-input')
      expect(sent).toEqual(['first'])
      native.resolve(); await Promise.all([one, two])
      expect(sent).toEqual(['first', '\u001b[1;2R'])
      await expect(client.writeAgent({ agentSessionId: stored.agentSessionId, expectedRun: stored.run, data: 'failure', source: 'user' })).rejects.toThrow('native rejection')
      expect((await client.clientPerformanceDiagnostics()).input).toMatchObject({ started: 3, completed: 2, failed: 1, pending: 0,
        currentRun: { count: 3 }, nativeInput: { count: 3 } })
      expect((await client.clientPerformanceDiagnostics()).input.recent.at(-1)?.stage).toBe('native-input')
      await client.writeAgent({ agentSessionId: stored.agentSessionId, expectedRun: stored.run, data: '', source: 'user' })
      await client.writeAgent({ agentSessionId: stored.agentSessionId, expectedRun: stored.run, data: new Uint8Array(), source: 'terminal-protocol' })
      expect(sent).toHaveLength(3)
      expect((await client.clientPerformanceDiagnostics()).input).toMatchObject({ started: 5, completed: 4, failed: 1,
        kinds: { user: 3, protocol: 2, semantic: 0 }, nativeInput: { count: 3 } })
      expect((await client.clientPerformanceDiagnostics()).input.recent.slice(-2).map(entry => entry.bytes)).toEqual([0, 0])
      await client.writeAgent({ agentSessionId: stored.agentSessionId, expectedRun: stored.run, data: '\u001b[<0;10;20M', source: 'user' })
      await client.writeAgent({ agentSessionId: stored.agentSessionId, expectedRun: stored.run, data: '\u001b[<0;10;20Mtext', source: 'user' })
      expect((await client.clientPerformanceDiagnostics()).input).toMatchObject({ kinds: { mouse: 1, user: 4, protocol: 2 } })
      expect((await client.clientPerformanceDiagnostics()).input.recent.slice(-2).map(entry => entry.kind)).toEqual(['mouse', 'user'])
      expect(connect).not.toHaveBeenCalled()
    } finally { native.resolve(); status.resolve(); await client.dispose() }
  })
})
