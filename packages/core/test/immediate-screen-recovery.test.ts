import { fixturePath as upstreamFixturePath } from './helpers/fixture-values.js'
import { expect, it, vi } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentScreenEvidenceStore } from '../src/screen-evidence.js'
import type { CtxmuxAdapterObservationEvent } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxAgentSession } from '../src/types.js'

const session = { kind: 'agent', agentSessionId: 'native-attributes', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: upstreamFixturePath("private"), run: { runId: 'private' }, retiredRuns: [], createdAt: 1, updatedAt: 1 } as AgentMuxAgentSession
const frame = (marker: string, text: string) => Buffer.from(`\x1b[?2026h\x1b[2J\x1b[12;1H${marker} \x1b[2m${text}\x1b[22m\x1b[12;3H\x1b[?2026l`)
const options = { timeoutMs: 100, timeoutMessage: 'private attribute timeout', terminalMessage: 'private exit', requireCompleteFrame: true, requireOriginalAttributes: true }

it.each([['>', 'placeholder'], ['›', 'dim native hint']])('recovers exact original attributes for %s and preserves drafts after the cursor', async (marker, text) => {
 const bytes = frame(marker, text), close = vi.fn(async () => {}), listeners: Array<(event: CtxmuxAdapterObservationEvent) => void> = []
 const observe = vi.fn(async (_id: string, after: number, listener: (event: CtxmuxAdapterObservationEvent) => void, view: string) => {
  listeners.push(listener)
  const checkpoint = { runId: 'private', throughByte: bytes.length, resizeRevision: 0, size: { cols: 100, rows: 30 }, restoreSize: { cols: 100, rows: 30 }, restoreScrollbackRows: null, resizeAfterRestoreBytes: 0 }
  return { run: { runId: 'private', cols: 100, rows: 30, latestOutputBytes: bytes.length }, resizeRevision: 0, gap: null, close,
   terminal: view === 'raw' ? { type: 'not-requested' } : { type: 'basic-vt', checkpoint, restoreBytes: Buffer.from(bytes.toString().replaceAll('\x1b[2m', '')), resizes: [] },
   replay: view === 'raw' ? [{ startByte: 0, endByte: bytes.length, dataBytes: bytes }] : [] }
 })
 const store = new AgentScreenEvidenceStore({ kernel: { observeOutput: observe } as never, providers: new AgentProviderRegistry() })
 try {
  await store.wait(session, bytes.length, false, () => true, { ...options, requireOriginalAttributes: false, requireCompleteFrame: false })
  await store.wait(session, bytes.length, false, screen => screen.snapshot().lines[11]!.cells.slice(2, 2 + text.length).every(cell => cell.dim), options)
  expect(observe.mock.calls.map(call => [call[1], call[3]])).toEqual([[0, 'terminal'], [0, 'raw']])
  const draft = Buffer.from('\x1b[?2026h\x1b[12;3H\x1b[22mUNAUTHORIZED\x1b[12;3H\x1b[?2026l')
  listeners.at(-1)!({ type: 'data', runId: 'private', startByte: bytes.length, endByte: bytes.length + draft.length, dataBytes: draft, data: draft.toString() } as CtxmuxAdapterObservationEvent)
  await store.wait(session, bytes.length + draft.length, false, screen => {
   expect(screen.composerText(marker)).toBe('')
   return screen.snapshot().lines[11]!.cells.some(cell => cell.chars === 'U' && !cell.dim)
  }, options)
  expect(observe).toHaveBeenCalledTimes(2) // Subsequent observers share the incremental original stream.
 } finally { store.discardAll() }
})

it('keeps a retained suffix unknown and can recover after an actual terminal reset', async () => {
 const bytes = frame('>', 'placeholder'), origin = 100, end = origin + bytes.length
 let listener!: (event: CtxmuxAdapterObservationEvent) => void
 const store = new AgentScreenEvidenceStore({ providers: new AgentProviderRegistry(), kernel: { observeOutput: async (_id: string, after: number, accept: typeof listener, view: string) => {
  expect(after).toBe(0); expect(view).toBe('raw');listener = accept
  return { run: { runId: 'private', cols: 100, rows: 30, latestOutputBytes: end }, resizeRevision: 0,
   terminal: { type: 'not-requested' }, gap: { requestedAfterByte: 0, firstAvailableByte: origin }, close: vi.fn(async () => {}),
   replay: [{ startByte: origin, endByte: end, dataBytes: bytes }] }
 } } as never })
 try {
  await expect(store.wait(session, end, false, () => true, options)).rejects.toMatchObject({ code: 'OUTPUT_GAP' })
  const reset = Buffer.concat([Buffer.from('\x1bc'), frame('>', 'placeholder')])
  listener({ type: 'data', runId: 'private', startByte: end, endByte: end + reset.length, dataBytes: reset, data: reset.toString() } as CtxmuxAdapterObservationEvent)
  await expect(store.wait(session, end + reset.length, false, screen => screen.snapshot().lines[11]!.cells[2]!.dim, options)).resolves.toBe(end + reset.length)
 } finally { store.discardAll() }
})
