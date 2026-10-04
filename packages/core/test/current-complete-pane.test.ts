import { expect, it, vi } from 'vitest'
import { AgentScreenEvidenceStore } from '../src/screen-evidence.js'
import { AgentTerminalScreenEvidence } from '../src/agent-terminal-screen.js'

const markers = { start: '\x1b[?2026h', end: '\x1b[?2026l' }
const drawing = '\x1b[2J\x1b[10;1H> \x1b[10;3H'
const raw = Buffer.from('\x1bc' + markers.start + drawing + markers.end)
const chunk = (bytes: Buffer, startByte = 0) => ({ startByte, endByte: startByte + bytes.length, dataBytes: bytes })
const session = { agentSessionId: 'current-pane', providerId: 'controlled', run: { runId: 'original-run' } } as any
const options = { timeoutMs: 20, requireCompleteFrame: true, timeoutMessage: 'original observation deadline', terminalMessage: 'original Run ended' }
const predicate = (screen: any) => screen.composerText('>') === ''
const flush = async (evidence: AgentTerminalScreenEvidence) => { await (evidence as any).tail }
const result = (promise: Promise<unknown>) => promise.then(value => ({ value }), error => ({ code: error.code }))
function fixture(checkpoint = false, bytes = raw, variant = '') {
  let emit!: (event: any) => void
  const restore = Buffer.from(drawing), fence = bytes.length
  const cp = { runId: 'original-run', throughByte: fence, resizeRevision: 1, size: { cols: 81, rows: 24 }, restoreSize: { cols: 80, rows: 24 }, restoreScrollbackRows: null, resizeAfterRestoreBytes: restore.length }
  const observeOutput = vi.fn(async (_run: string, _byte: number, accept: (event: any) => void) => {
    emit = accept
    return { run: { runId: 'original-run', cols: checkpoint ? 81 : 80, rows: 24, latestOutputBytes: fence }, resizeRevision: checkpoint ? variant === 'geometry' ? 2 : 1 : 0,
      gap: null, close: async () => {}, terminal: checkpoint ? { type: 'basic-vt', checkpoint: cp, restoreBytes: variant === 'synthetic' ? raw : restore, resizes: [] } : { type: 'not-requested' },
      replay: checkpoint ? [] : [chunk(bytes)] }
  })
  const replay = vi.fn(async () => ({ run: { runId: 'original-run', latestOutputBytes: fence }, gap: variant === 'gap' ? { firstAvailableByte: fence } : null,
    replay: variant === 'missing' || variant === 'synthetic' ? [] : [chunk(variant === 'fence' ? bytes.subarray(0, -1) : bytes)] }))
  const store = new AgentScreenEvidenceStore({ providers: { get: () => ({ terminalPromptRender: { frameStart: markers.start, frameEnd: markers.end } }) }, kernel: { observeOutput, replay } } as never)
  return { store, emit: (event: any) => emit(event), observeOutput, replay, fence }
}

it('reuses the live resized current pane without new output but requires new drawing at current geometry', async () => {
  const f = fixture()
  try {
    await f.store.wait(session, raw.length, false, predicate, options)
    const original = (f.store as any).evidence.get(session.agentSessionId).evidence
    f.emit({ type: 'resized', cols: 81, rows: 24, throughByte: raw.length, resizeRevision: 1 })
    expect(await result(f.store.wait(session, raw.length, false, screen => predicate(screen) && screen.snapshot().cols === 81, options))).toEqual({ value: raw.length })
    expect((f.store as any).evidence.get(session.agentSessionId).evidence).toBe(original)
    expect(original.completeSnapshot).toMatchObject({ geometryRevision: 1, outputThroughByte: raw.length })
    expect(f.observeOutput).toHaveBeenCalledOnce(); expect(f.replay).not.toHaveBeenCalled()
    // The old frame starts after boundary 0, but predates the later resize.
    expect(await result(f.store.wait(session, 0, false, predicate, { ...options, requireFrameAfterBoundary: true }))).toEqual({ code: 'AGENT_PROMPT_RENDER_TIMEOUT' })
    f.emit({ type: 'data', ...chunk(raw, raw.length) })
    expect(await result(f.store.wait(session, raw.length, true, predicate, { ...options, requireFrameAfterBoundary: true }))).toEqual({ value: raw.length * 2 })
  } finally { f.store.discardAll() }
})

it('recovers checkpoint current closure from bounded same-fence raw without claiming a new geometry drawing', async () => {
  const f = fixture(true)
  try {
    expect(await result(f.store.wait(session, raw.length, false, predicate, options))).toEqual({ value: raw.length })
    const current = f.store.currentCompleteFrame(session)!
    expect(current).toMatchObject({ outputThroughByte: raw.length, geometryRevision: 1, snapshot: { cols: 81, rows: 24 } })
    expect(f.replay.mock.calls).toHaveLength(1)
    expect(await result(f.store.wait(session, 0, false, predicate, { ...options, requireFrameAfterBoundary: true }))).toEqual({ code: 'AGENT_PROMPT_RENDER_TIMEOUT' })
  } finally { f.store.discardAll() }
})

it.each(['open', 'partial'] as const)('retains %s frame state across a live resize and rejects it as a closed current pane', async variant => {
  const evidence = new AgentTerminalScreenEvidence(80, 24, markers)
  const suffix = Buffer.from(variant === 'open' ? markers.start + '\x1b[10;3H' : markers.start.slice(0, 4))
  const bytes = Buffer.concat([raw, suffix])
  try {
    evidence.accept({ type: 'data', ...chunk(bytes) }); await flush(evidence)
    evidence.accept({ type: 'resized', cols: 81, rows: 24, throughByte: bytes.length, resizeRevision: 1 }); await flush(evidence)
    expect(evidence.completeSnapshot).toBeNull()
    expect(await result(evidence.wait({ ...options, boundaryByte: bytes.length, requireOutputAfterBoundary: false, predicate }))).toEqual({ code: 'AGENT_PROMPT_RENDER_TIMEOUT' })
    const remainder = Buffer.from((variant === 'partial' ? markers.start.slice(4) : '') + markers.end)
    evidence.accept({ type: 'data', ...chunk(remainder, bytes.length) }); await flush(evidence)
    expect(evidence.completeSnapshot).not.toBeNull()
    expect(await result(evidence.wait({ ...options, boundaryByte: 0, requireOutputAfterBoundary: false, requireFrameAfterBoundary: true, predicate }))).toEqual({ code: 'AGENT_PROMPT_RENDER_TIMEOUT' })
  } finally { evidence.dispose() }
})

it.each(['open', 'partial', 'missing', 'synthetic', 'gap', 'fence', 'geometry'] as const)('rejects checkpoint %s evidence despite positive current cells', async variant => {
  const bytes = variant === 'open' ? Buffer.concat([raw, Buffer.from(markers.start)]) : variant === 'partial' ? Buffer.concat([raw, Buffer.from(markers.start.slice(0, 4))]) : raw
  const f = fixture(true, bytes, variant)
  try {
    expect(await result(f.store.wait(session, bytes.length, false, predicate, options))).toEqual({ code: variant === 'fence' ? 'OUTPUT_GAP' : variant === 'geometry' ? 'CTXMUX_EVENT_INVALID' : 'AGENT_PROMPT_RENDER_TIMEOUT' })
    expect(f.store.currentCompleteFrame(session)).toBeNull()
  } finally { f.store.discardAll() }
})
