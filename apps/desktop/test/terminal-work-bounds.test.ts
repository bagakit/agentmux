import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { terminalContinuationSteps, type AgentMuxRunAttachment } from '@agentmux/core'
import { initialKittyKeyboardState, readKittyKeyboardOutput, KITTY_KEYBOARD_STACK_LIMIT } from '../src/renderer/src/lib/terminal-kitty-keyboard'
import { TerminalLiveOutputQueue, composeTerminalLiveOutputWrite } from '../../../packages/client-ui/src/terminal/live-output'
import { hydrateTerminalReplay, restoreTerminalCheckpoint, yieldTerminalWork, TERMINAL_REPLAY_BATCH_BYTES } from '../../../packages/client-ui/src/terminal/replay'

declare const __AGENTMUX_TERMINAL_VIEW_SOURCE__: string | undefined
const source = typeof __AGENTMUX_TERMINAL_VIEW_SOURCE__ === 'string' ? __AGENTMUX_TERMINAL_VIEW_SOURCE__ : readFileSync(resolve('apps/desktop/src/renderer/src/components/TerminalView.tsx'), 'utf8')
const syntax = ts.createSourceFile('TerminalView.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function arrow(name: string): string {
  let found: ts.ArrowFunction | undefined
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer && ts.isArrowFunction(node.initializer)) found = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(syntax)
  expect(found, `actual production declaration ${name}`).toBeDefined()
  return ts.transpileModule('const callback = ' + found!.getText(syntax), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText.replace('const callback = ', '').trim().replace(/;$/, '')
}
function owner(onYield?: (count: number) => void) {
  const writes: Uint8Array[] = [], sizes: number[] = [], yields: number[] = []
  const queue = new TerminalLiveOutputQueue()
  const yieldWork = async () => { yields.push(sizes.length); onYield?.(sizes.length); await yieldTerminalWork() }
  const bindings = {
    terminalContinuationSteps, TERMINAL_REPLAY_BATCH_BYTES, composeTerminalLiveOutputWrite,
    hydrateTerminalReplay: (chunks: Parameters<typeof hydrateTerminalReplay>[0], write: Parameters<typeof hydrateTerminalReplay>[1]) => hydrateTerminalReplay(chunks, write, yieldWork),
    restoreTerminalCheckpoint: (bytes: Uint8Array, write: Parameters<typeof hydrateTerminalReplay>[1]) => restoreTerminalCheckpoint(bytes, write, yieldWork),
    yieldTerminalWork: yieldWork,
    viewport: { acceptOwnerSize: (size: { cols: number }) => sizes.push(size.cols) },
    terminal: { options: { scrollback: 5000 } },
    writeTerminal: async (bytes: Uint8Array) => { writes.push(bytes.slice()) },
    writeOutput: async (bytes: Uint8Array) => { writes.push(bytes.slice()) },
    liveOutputQueue: queue,
    backfillRetainedOutput: async () => { throw new Error('unexpected backfill') },
    setContinuationAbsence: () => {}, canControlRunRef: { current: false }
  }
  const create = new Function(...Object.keys(bindings), `
    let cursor = 0, resizeRevision = 0, geometrySteps = 0;
    let disposed = false, continuationKnown = true, replayingContinuation = false;
    const readyForLiveOutput = true;
    let droppedPendingThrough = 0, liveGapRedrawPending = false;
    const acceptUncontinuedSnapshot = () => { throw new Error('unexpected discontinuity') };
    const applyContinuation = ${arrow('applyContinuation')};
    const drainLiveOutput = ${arrow('drainLiveOutput')};
    return { applyContinuation, drainLiveOutput, dispose: () => { disposed = true }, state: () => ({ cursor, resizeRevision }) };
  `)
  return { ...create(...Object.values(bindings)) as { applyContinuation(snapshot: unknown, preserve?: boolean): Promise<void>; drainLiveOutput(): Promise<void>; dispose(): void; state(): { cursor: number; resizeRevision: number } }, writes, sizes, yields, queue }
}
const enc = new TextEncoder()
function attachment(data: Uint8Array, resizes: Array<{ throughByte: number; resizeRevision: number; size: { cols: number; rows: number } }> = []) {
  return { run: { runId: 'original', latestOutputBytes: data.length }, resizeRevision: resizes.length,
    terminal: { type: 'basic-vt', checkpoint: { runId: 'original', throughByte: 0, resizeRevision: 0, size: { cols: 80, rows: 24 }, restoreSize: { cols: 80, rows: 24 }, restoreScrollbackRows: null, resizeAfterRestoreBytes: 1 }, restoreBytes: enc.encode('R'), resizes },
    replay: data.length ? [{ startByte: 0, endByte: data.length, dataBytes: data }] : [] }
}

describe('Terminal protocol and production work bounds', () => {
  it('bounds the Kitty stack by evicting oldest and ordinary chunks retain stack identity', () => {
    let state = initialKittyKeyboardState()
    for (let i = 1; i <= 10000; i++) state = readKittyKeyboardOutput(state, `\x1b[>${i}u`)
    expect(state.stack).toEqual(Array.from({ length: KITTY_KEYBOARD_STACK_LIMIT }, (_, i) => 10001 - KITTY_KEYBOARD_STACK_LIMIT + i))
    const ordinary = readKittyKeyboardOutput(state, 'ordinary output'.repeat(100))
    expect(ordinary).toBe(state)
    expect(ordinary.stack).toBe(state.stack)
    state = readKittyKeyboardOutput(state, '\x1b[<15u')
    expect(state.stack).toEqual([10001 - KITTY_KEYBOARD_STACK_LIMIT])
    expect(readKittyKeyboardOutput(state, '\x1b[<1000u').stack).toEqual([])
  })

  it('keeps independent screen stacks across same-chunk and split DEC switches and reset', () => {
    let state = readKittyKeyboardOutput(initialKittyKeyboardState(), '\x1b[>1u\x1b[?1049h\x1b[>4u\x1b[=2;2u\x1b[?1049l')
    expect(state.stack).toEqual([1])
    expect(state.inactiveStack).toEqual([6])
    state = readKittyKeyboardOutput(state, '\x1b[?104')
    expect(readKittyKeyboardOutput(state, '9h\x1b[=2;3u').stack).toEqual([4])
    const split = readKittyKeyboardOutput(readKittyKeyboardOutput(state, '9h\x1b'), 'c')
    expect(split.stack).toEqual([])
    expect(split.inactiveStack).toEqual([])
    expect(split.screen).toBe('normal')
    const query = readKittyKeyboardOutput(readKittyKeyboardOutput(initialKittyKeyboardState(), '\x1b[>7'), 'u\x1b[?u\x1b[?0u')
    expect(query.stack).toEqual([7])
  })

  it('splits an oversized first live event within the byte bound and keeps exact cursor through snapshot admission', () => {
    const data = enc.encode('A'.repeat(65534) + '中\x1b[31m' + 'B'.repeat(131072))
    const queue = new TerminalLiveOutputQueue()
    queue.admit({ startByte: 17, endByte: 17 + data.length, dataBytes: data })
    const outputs: Uint8Array[] = []; let cursor = 17
    while (queue.length) {
      const taken = queue.take()
      const composed = composeTerminalLiveOutputWrite(taken.batch, cursor)
      expect(composed.dataBytes.length).toBeLessThanOrEqual(65536)
      expect(composed.gap).toBe(false)
      outputs.push(composed.dataBytes); cursor = composed.cursor
      expect(queue.byteLength).toBe(17 + data.length - cursor)
    }
    expect(Buffer.concat(outputs)).toEqual(Buffer.from(data))
    expect(cursor).toBe(17 + data.length)
    queue.admit({ startByte: 0, endByte: data.length, dataBytes: data })
    queue.take(100)
    const pending = [...queue][0] as { startByte: number; endByte: number; dataBytes: Uint8Array }
    expect(pending.startByte).toBe(100)
    queue.admitSnapshot({ run: { latestOutputBytes: 100 }, resizeRevision: 0, terminal: { type: 'unknown', reason: 'origin_unknown' }, replay: [] } as unknown as AgentMuxRunAttachment)
    expect([...queue][0]).toEqual(pending)
    expect(queue.take(23).batch[0]!.startByte).toBe(100)
  })

  it('actual continuation coalesces only contiguous data while keeping resize barriers and raw cursors', async () => {
    const view = owner()
    const raw = enc.encode('abcd')
    const snapshot = attachment(raw, [{ throughByte: 2, resizeRevision: 1, size: { cols: 91, rows: 24 } }])
    snapshot.replay = Array.from(raw, (_, i) => ({ startByte: i, endByte: i + 1, dataBytes: raw.subarray(i, i + 1) }))
    await view.applyContinuation(snapshot)
    expect(view.writes.map(bytes => new TextDecoder().decode(bytes))).toEqual(['R', 'ab', 'cd'])
    expect(view.sizes).toEqual([80, 91])
    expect(view.state()).toEqual({ cursor: 4, resizeRevision: 1 })
    const many = owner(), bytes = enc.encode('x'.repeat(100))
    const small = attachment(bytes)
    small.replay = Array.from(bytes, (_, i) => ({ startByte: i, endByte: i + 1, dataBytes: bytes.subarray(i, i + 1) }))
    await many.applyContinuation(small)
    expect(many.writes).toHaveLength(2)
    expect(many.writes[1]).toEqual(bytes)
  })

  it('actual continuation does not aggregate across raw gaps and stops after disposal at a yield', async () => {
    const gap = owner()
    await gap.applyContinuation({ run: { runId: 'original', latestOutputBytes: 4 }, resizeRevision: 0,
      terminal: { type: 'unknown', reason: 'origin_unknown' },
      replay: [{ startByte: 0, endByte: 1, dataBytes: enc.encode('a') }, { startByte: 3, endByte: 4, dataBytes: enc.encode('b') }] })
    expect(gap.writes.map(data => new TextDecoder().decode(data))).toEqual(['a', 'b'])
    expect(gap.state().cursor).toBe(4)
    let disposed: ReturnType<typeof owner>
    disposed = owner(count => { if (count > 1) disposed.dispose() })
    const resizes = Array.from({ length: 40 }, (_, i) => ({ throughByte: 0, resizeRevision: i + 1, size: { cols: 90 + i, rows: 24 } }))
    await disposed.applyContinuation(attachment(new Uint8Array(), resizes))
    expect(disposed.sizes.length).toBe(17)
    expect(disposed.state().resizeRevision).toBe(16)
  })

  it('actual continuation and live geometry drains yield before all changed grids finish', async () => {
    const resizes = Array.from({ length: 40 }, (_, i) => ({ throughByte: 0, resizeRevision: i + 1, size: { cols: 90 + i, rows: 24 } }))
    const view = owner(); await view.applyContinuation(attachment(new Uint8Array(), resizes))
    expect(view.yields.some(count => count > 1 && count < 41)).toBe(true)
    expect(view.sizes).toEqual([80, ...resizes.map(resize => resize.size.cols)])
    const live = owner(); resizes.forEach(resize => live.queue.admit(resize))
    await live.drainLiveOutput()
    expect(live.yields.some(count => count > 0 && count < 40)).toBe(true)
    expect(live.sizes).toEqual(resizes.map(resize => resize.size.cols))
    expect(live.state().resizeRevision).toBe(40)
    expect(live.queue.length).toBe(0)
  })
})
