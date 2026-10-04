import { fixturePath } from './helpers/fixture-values.js'
import { expect, it, vi } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentScreenEvidenceStore } from '../src/screen-evidence.js'
import type { CtxmuxAdapterObservationEvent } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxAgentSession } from '../src/types.js'

const session = { kind: 'agent', agentSessionId: 'native-attributes', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: fixturePath("private"), run: { runId: 'private' }, retiredRuns: [], createdAt: 1, updatedAt: 1 } as AgentMuxAgentSession
const drawing = (marker: string, text: string) => Buffer.from(`\x1b[2J\x1b[12;1H${marker} \x1b[2m${text}\x1b[22m\x1b[12;3H`)
const frame = (marker: string, text: string) => Buffer.concat([Buffer.from('\x1b[?2026h'), drawing(marker, text), Buffer.from('\x1b[?2026l')])
const options = { timeoutMs: 100, timeoutMessage: 'private attribute timeout', terminalMessage: 'private exit', requireCompleteFrame: true }
const checkpoint = (throughByte: number) => ({ runId: 'private', throughByte, resizeRevision: 5, size: { cols: 100, rows: 30 }, restoreSize: { cols: 100, rows: 30 }, restoreScrollbackRows: null, resizeAfterRestoreBytes: 0 })

it.each([['>', 'placeholder'], ['›', 'dim native hint']])('restores checkpoint attributes after historical resize for %s and preserves drafts after the cursor', async (marker, text) => {
 const origin = 1_000_000, seed = drawing(marker, text), original = frame(marker, text), close = vi.fn(async () => {}), listeners: Array<(event: CtxmuxAdapterObservationEvent) => void> = []
 const observe = vi.fn(async (_id: string, _after: number, listener: (event: CtxmuxAdapterObservationEvent) => void, view: string) => {
  expect(view).toBe('terminal'); listeners.push(listener)
  return { run: { runId: 'private', cols: 100, rows: 30, latestOutputBytes: origin }, resizeRevision: 5, gap: null, close,
   terminal: { type: 'basic-vt', checkpoint: checkpoint(origin), restoreBytes: seed, resizes: [] }, replay: [] }
 })
 const replay = vi.fn(async (_id: string, after: number, view: string) => {
  expect(after).toBe(origin - 64 * 1024); expect(view).toBe('raw')
  return { run: { latestOutputBytes: origin }, gap: null, replay: [{ startByte: origin - original.length, endByte: origin, dataBytes: original }] }
 })
 const store = new AgentScreenEvidenceStore({ kernel: { observeOutput: observe, replay } as never, providers: new AgentProviderRegistry() })
 try {
  // Same-fence original closure confirms the current resized pane, but cannot
  // prove that a new frame was drawn after the geometry changed.
  await store.wait(session, origin, false, screen => screen.geometryRevision === 5 && screen.snapshot().lines[11]!.cells.slice(2, 2 + text.length).every(cell => cell.dim), { ...options, requireCompleteFrame: false })
  await store.wait(session, origin, false, () => true, options)
  await expect(store.wait(session, 0, false, () => true, { ...options, timeoutMs: 10, requireFrameAfterBoundary: true })).rejects.toMatchObject({ code: 'AGENT_PROMPT_RENDER_TIMEOUT' })
  const generation = store.generation(session.agentSessionId)
  listeners[0]!({ type: 'resized', runId: 'private', cols: 100, rows: 30, throughByte: origin, resizeRevision: 6 } as CtxmuxAdapterObservationEvent)
  expect(store.generation(session.agentSessionId)).toBe(generation + 1)
  const rendered = frame(marker, text), partial = rendered.subarray(0, rendered.length - 8)
  listeners[0]!({ type: 'data', runId: 'private', startByte: origin, endByte: origin + partial.length, dataBytes: partial, data: partial.toString() } as CtxmuxAdapterObservationEvent)
  await expect(store.wait(session, origin, true, () => true, { ...options, timeoutMs: 10 })).rejects.toMatchObject({ code: 'AGENT_PROMPT_RENDER_TIMEOUT' })
  const end = rendered.subarray(partial.length)
  listeners[0]!({ type: 'data', runId: 'private', startByte: origin + partial.length, endByte: origin + rendered.length, dataBytes: end, data: end.toString() } as CtxmuxAdapterObservationEvent)
  await store.wait(session, origin, true, screen => screen.snapshot().lines[11]!.cells[2]!.dim, options)
  const draft = Buffer.from('\x1b[?2026h\x1b[12;3H\x1b[22mUNAUTHORIZED\x1b[12;3H\x1b[?2026l')
  listeners[0]!({ type: 'data', runId: 'private', startByte: origin + rendered.length, endByte: origin + rendered.length + draft.length, dataBytes: draft, data: draft.toString() } as CtxmuxAdapterObservationEvent)
  await store.wait(session, origin + rendered.length + draft.length, false, screen => {
   expect(screen.composerText(marker)).toBe('')
   return screen.snapshot().lines[11]!.cells.some(cell => cell.chars === 'U' && !cell.dim)
  }, options)
  expect(observe.mock.calls.map(call => [call[1], call[3]])).toEqual([[origin - 64 * 1024, 'terminal']]); expect(replay).toHaveBeenCalledOnce()
 } finally { store.discardAll() }
})

it('keeps unavailable historical geometry unknown and recovers through a refreshed owner checkpoint', async () => {
 const bytes = frame('>', 'placeholder'), origin = 100, end = origin + bytes.length
 let available = false
 const store = new AgentScreenEvidenceStore({ providers: new AgentProviderRegistry(), kernel: { replay: async () => ({ run: { latestOutputBytes: end }, gap: null, replay: [] }), observeOutput: async (_id: string, _after: number, _accept: unknown, view: string) => {
  expect(view).toBe('terminal')
  return { run: { runId: 'private', cols: 100, rows: 30, latestOutputBytes: end }, resizeRevision: 5, gap: null, close: vi.fn(async () => {}),
   terminal: available ? { type: 'basic-vt', checkpoint: checkpoint(end), restoreBytes: drawing('>', 'placeholder'), resizes: [] } : { type: 'unavailable', reason: 'origin_unknown' },
   replay: available ? [] : [{ startByte: 0, endByte: end, dataBytes: Buffer.concat([Buffer.alloc(origin), bytes]) }] }
 } } as never })
 try {
  await expect(store.wait(session, end, false, () => true, options)).rejects.toMatchObject({ code: 'OUTPUT_GAP' })
  store.discard(session.agentSessionId); available = true
  await expect(store.wait(session, end, false, screen => screen.snapshot().lines[11]!.cells[2]!.dim, { ...options, requireCompleteFrame: false })).resolves.toBe(end)
 } finally { store.discardAll() }
})


it('cold retry accepts only a real closed frame after its durable refresh fence at the matching geometry', async () => {
 const origin = 1_000_000, old = frame('>', 'old geometry'), fresh = frame('>', 'placeholder'), cut = origin + fresh.length
 const replay = vi.fn(async () => ({ run: { latestOutputBytes: cut }, gap: null, replay: [{ startByte: origin - old.length, endByte: cut, dataBytes: Buffer.concat([old, fresh]) }] }))
 const observe = vi.fn(async () => ({ run: { runId: 'private', cols: 100, rows: 30, latestOutputBytes: cut }, resizeRevision: 5, gap: null, close: vi.fn(async () => {}), terminal: { type: 'basic-vt', checkpoint: checkpoint(cut), restoreBytes: drawing('>', 'placeholder'), resizes: [] }, replay: [] }))
 const store = new AgentScreenEvidenceStore({ kernel: { observeOutput: observe, replay } as never, providers: new AgentProviderRegistry() })
 try {
  await store.wait(session, origin, true, screen => screen.geometryRevision === 5 && screen.snapshot().lines[11]!.cells[2]!.dim, { ...options, requireFrameAfterBoundary: true, checkpointFrameFence: { outputByte: origin, resizeRevision: 5 } })
  await expect(store.wait(session, cut, true, () => true, { ...options, timeoutMs: 10, requireFrameAfterBoundary: true, checkpointFrameFence: { outputByte: cut, resizeRevision: 5 } })).rejects.toMatchObject({ code: 'AGENT_PROMPT_RENDER_TIMEOUT' })
  store.discardAll()
  await expect(store.wait(session, origin, true, () => true, { ...options, timeoutMs: 10, requireFrameAfterBoundary: true, checkpointFrameFence: { outputByte: origin, resizeRevision: 6 } })).rejects.toMatchObject({ code: 'AGENT_PROMPT_RENDER_TIMEOUT' })
 } finally { store.discardAll() }
})
