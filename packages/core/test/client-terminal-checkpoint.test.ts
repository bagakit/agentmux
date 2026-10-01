import { afterEach, expect, it, vi } from 'vitest'
import type { AttachedSnapshot, RunInfo } from '@ctxmux/sdk'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import { AgentTerminalScreenEvidence } from '../src/agent-terminal-screen.js'
import { terminalContinuationSteps } from '../src/terminal-continuation.js'
import type { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)
const clients: AgentMuxClient[] = []
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.dispose())) })

function runInfo(): RunInfo {
  return { native_service: null, id: 'continuation-run', spec: { program: 'fixture', args: [], cwd: '/fixture', env: {},
    initial_size: { cols: 12, rows: 4 }, declared_inputs: [] }, lineage: null, backend: { type: 'native' },
    capabilities: { input: true, resize: true, signal: true, stop: true,
      fork_level_a: false, fork_level_b: false, replay: 'raw_from_start' },
    pid: 1234, state: { type: 'running' }, latest_output_bytes: 103,
    durable_output_bytes: 103, first_available_byte: 90, attachments: 1,
    applied_input_bytes: 0, current_size: { cols: 12, rows: 4 } }
}
function sdkSnapshot(terminal: boolean): AttachedSnapshot {
  const restore = bytes('\x1bcOLD\r\nKEPT\r\n\x1b[?1049h\x1b[?1003h\x1b[?1006h')
  return { run: runInfo(), resize_revision: 2,
    terminal: terminal ? { type: 'basic_vt', checkpoint: { restore_size: { cols: 12, rows: 4 }, restore_scrollback_rows: null, resize_after_restore_bytes: 0, run_id: 'continuation-run', through_byte: 100,
      resize_revision: 2, size: { cols: 12, rows: 4 }, restore_bytes: restore.length }, resizes: [] }
      : { type: 'not_requested' }, terminal_restore: terminal ? restore : new Uint8Array(0),
    replay: { chunks: [{ start_byte: 100, end_byte: 103, data: bytes('new') }],
      first_available_byte: 90, latest_output_bytes: 103, truncated: !terminal } }
}
async function fixture(agent = false) {
  const store = new AgentMuxMemoryAgentSessionStore()
  const stored: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'continuation-agent',
    providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: '/fixture',
    run: { runId: 'continuation-run' }, retiredRuns: [], hookBindingId: 'fixture-binding',
    hookToken: 'fixture-token', createdAt: 1, updatedAt: 1 }
  if (agent) await store.compareAndSwap(null, stored)
  const client = new AgentMuxClient({ store }); clients.push(client)
  const inner = client as unknown as { connected: boolean; kernel: CtxmuxRunAdapter; registry: AgentMuxAgentSessionRegistry }
  await inner.registry.load('local'); inner.connected = true
  const detach = vi.fn(async () => {})
  const attachment = (terminal: boolean) => ({ snapshot: sdkSnapshot(terminal), detach, close: vi.fn(),
    async *events() { yield { type: 'exited', state: { type: 'exited', code: 0, signal: null } } } })
  const raw = vi.fn(async (_id: string, _afterByte: number) => attachment(false))
  const terminal = vi.fn(async (_id: string, _afterByte: number) => attachment(true))
  ;(inner.kernel as unknown as { client: unknown }).client = { attach: raw, attachTerminal: terminal }
  return { client, raw, terminal, detach, stored }
}

it('public terminal attachment selects one SDK representation, keeping seed out of published output', async () => {
  const h = await fixture(); const events: unknown[] = []; h.client.onEvent(event => events.push(event))
  const result = await h.client.attachTerminal('continuation-run', 0, 'terminal')
  expect(h.terminal.mock.calls).toEqual([['continuation-run', 0]])
  expect(h.raw).not.toHaveBeenCalled()
  expect(result.terminal).toMatchObject({ type: 'basic-vt', checkpoint: { throughByte: 100, resizeRevision: 2 } })
  expect(result.gap).toBeNull()
  expect(result.replay.map(chunk => [chunk.startByte, chunk.endByte, chunk.data])).toEqual([[100, 103, 'new']])
  expect(result.resizeRevision).toBe(2)
  expect(events.filter(event => (event as { type: string }).type === 'terminal-output')).toEqual([])
})
it('Agent reattach exposes authority without changing durable identity', async () => {
  const h = await fixture(true)
  const result = await h.client.reattachAgent(h.stored.agentSessionId, 0, 'terminal')
  expect(h.terminal.mock.calls).toEqual([['continuation-run', 0]])
  expect(result.session.agentSessionId).toBe(h.stored.agentSessionId)
  expect(result.attachment.terminal).toMatchObject({ type: 'basic-vt', checkpoint: { runId: h.stored.run.runId } })
  expect(result.attachment.replay.map(chunk => chunk.data)).toEqual(['new'])
})
it('raw replay remains original bytes and terminal replay uses independent short attachment cleanup', async () => {
  const h = await fixture()
  const raw = await h.client.readRunReplay({ runId: 'continuation-run' }, 0)
  expect(h.raw.mock.calls).toEqual([['continuation-run', 0]])
  expect(raw.terminal).toEqual({ type: 'not-requested' })
  expect(raw.gap).toEqual({ requestedAfterByte: 0, firstAvailableByte: 90 })
  const terminal = await h.client.readRunReplay({ runId: 'continuation-run' }, 0, 'terminal')
  expect(h.terminal.mock.calls).toEqual([['continuation-run', 0]])
  expect(terminal.terminal.type).toBe('basic-vt')
  expect(h.detach).toHaveBeenCalledTimes(2)
})
function orderedSnapshot(): Parameters<typeof terminalContinuationSteps>[0] {
  return { run: { runId: 'ordered', latestOutputBytes: 104 }, resizeRevision: 5,
    terminal: { type: 'basic-vt', checkpoint: { restoreSize: { cols: 12, rows: 4 }, restoreScrollbackRows: null, resizeAfterRestoreBytes: 0, runId: 'ordered', throughByte: 100,
      resizeRevision: 2, size: { cols: 12, rows: 4 } }, restoreBytes: bytes('\x1bc'), resizes: [
      { throughByte: 100, resizeRevision: 3, size: { cols: 8, rows: 4 } },
      { throughByte: 102, resizeRevision: 4, size: { cols: 7, rows: 4 } },
      { throughByte: 102, resizeRevision: 5, size: { cols: 12, rows: 4 } }] },
    replay: [{ startByte: 100, endByte: 104, dataBytes: bytes('界x') }] }
}
it('shared ordering preserves original UTF8 byte slices and both same-byte resizes', () => {
  const snapshot = orderedSnapshot(); const steps = [...terminalContinuationSteps(snapshot)]
  expect(steps.map(step => step.type)).toEqual(['restore', 'resized', 'data', 'resized', 'resized', 'data'])
  expect(steps.filter(step => step.type === 'resized').map(step => step.resizeRevision)).toEqual([3, 4, 5])
  const chunks = steps.filter(step => step.type === 'data')
  expect(chunks.map(chunk => [chunk.startByte, chunk.endByte])).toEqual([[100, 102], [102, 104]])
  expect(Buffer.concat(chunks.map(chunk => Buffer.from(chunk.dataBytes)))).toEqual(Buffer.from('界x'))
  expect(chunks[0]!.dataBytes.buffer).toBe(snapshot.replay[0]!.dataBytes.buffer)
})
it('missing resize or discontinuous tail cannot claim complete continuation', () => {
  const snapshot = orderedSnapshot()
  if (snapshot.terminal.type !== 'basic-vt') throw new Error('fixture lost its basic case')
  snapshot.terminal.resizes.splice(1, 1)
  expect(() => [...terminalContinuationSteps(snapshot)]).toThrow('inconsistent byte or geometry')
  const gap = orderedSnapshot(); gap.replay = [{ startByte: 101, endByte: 104, dataBytes: bytes('abc') }]
  expect(() => [...terminalContinuationSteps(gap)]).toThrow('inconsistent byte or geometry')
})
it('seed establishes a screen but cannot fake a fresh original frame or increase raw cursor', async () => {
  const checkpoint = { restoreSize: { cols: 20, rows: 4 }, restoreScrollbackRows: null, resizeAfterRestoreBytes: 0, runId: 'screen', throughByte: 200, resizeRevision: 3, size: { cols: 20, rows: 4 } }
  const evidence = new AgentTerminalScreenEvidence(20, 4, { start: '\x1b[?2026h', end: '\x1b[?2026l' }, 200, false, 3)
  try {
    evidence.accept({ type: 'restore', checkpoint, restoreBytes: bytes('\x1bc\x1b[?2026h› restored\x1b[?2026l') })
    expect(await evidence.wait({ boundaryByte: 200, requireOutputAfterBoundary: false,
      predicate: screen => screen.composerText('›') === 'restored', timeoutMs: 1000,
      timeoutMessage: 'fixture did not restore', terminalMessage: 'fixture stopped' })).toBe(200)
    expect(evidence.lastCompleteFrame).toBeNull()
    const original = bytes('\x1b[?2026h\r\x1b[2K› current\x1b[?2026l')
    evidence.accept({ type: 'data', startByte: 200, endByte: 200 + original.length, dataBytes: original })
    expect(await evidence.wait({ boundaryByte: 200, requireOutputAfterBoundary: true, requireFrameAfterBoundary: true,
      predicate: screen => screen.composerText('›') === 'current', timeoutMs: 1000,
      timeoutMessage: 'fixture did not advance', terminalMessage: 'fixture stopped' })).toBe(200 + original.length)
    expect(evidence.lastCompleteFrame).toEqual({ startByte: 200, endByte: 200 + original.length })
  } finally { evidence.dispose() }
})
it('unknown origin remains untrusted even if supplied suffix starts at zero', async () => {
  const evidence = new AgentTerminalScreenEvidence(20, 4, null, 0, false, 0)
  try {
    const original = bytes('› apparent')
    evidence.accept({ type: 'data', startByte: 0, endByte: original.length, dataBytes: original })
    await expect(evidence.wait({ boundaryByte: 0, requireOutputAfterBoundary: false, predicate: () => true,
      timeoutMs: 1000, timeoutMessage: 'fixture', terminalMessage: 'fixture' })).rejects.toMatchObject({ code: 'OUTPUT_GAP' })
  } finally { evidence.dispose() }
})
