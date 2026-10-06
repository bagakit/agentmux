import { fixtureEpoch as _newTailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { fixturePath } from '../../../test/fixture-values.mjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMuxClientEvent, AgentMuxRunAttachment } from '@agentmux/core'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { createMobileTerminalReader, type MobileTerminalCanvas, type MobileTerminalReading } from '../src/terminal/reader'
import { deferred, session } from './conversation-fixture'

const encode = (text: string) => new TextEncoder().encode(text)
function snapshot(bytes = new Uint8Array(), options: { start?: number; checkpoint?: number; restore?: string; resizes?: Array<{ throughByte: number; resizeRevision: number; size: { cols: number; rows: number } }> } = {}): AgentMuxRunAttachment {
  const start = options.start ?? options.checkpoint ?? 0, resizes = options.resizes ?? []
  return { run: { runId: 'run-original', nativeService: null, kind: 'agent', providerId: 'codex', executorId: 'local', agentSessionId: 'session-original',
    workspacePath: fixturePath("workspace"), pid: 10, state: 'running', cols: 80, rows: 24, observedAt: 1, latestOutputBytes: start + bytes.length, acceptedInputBytes: 0 },
    replay: bytes.length ? [{ runId: 'run-original', type: 'data', startByte: start, endByte: start + bytes.length, dataBytes: bytes, data: '' }] : [],
    gap: null, resizeRevision: resizes.at(-1)?.resizeRevision ?? 0,
    terminal: options.checkpoint === undefined ? { type: 'not-requested' } : { type: 'basic-vt',
      checkpoint: { runId: 'run-original', throughByte: options.checkpoint, resizeRevision: 0, size: { cols: 80, rows: 24 },
        restoreSize: { cols: 80, rows: 24 }, restoreScrollbackRows: null, resizeAfterRestoreBytes: 0 },
    restoreBytes: encode(options.restore ?? '\x1b[0m'), resizes } }
}
function harness(initial: AgentMuxRunAttachment = snapshot()) {
  const events = new Set<(event: AgentMuxClientEvent) => void>()
  const sizes: Array<[number, number]> = [], bytes: number[] = [], pendingWrites: Array<() => void> = [], reports: MobileTerminalReading[] = []
  let delayWrites = false
  let sessionFact = session()
  const canvas: MobileTerminalCanvas = { options: { scrollback: 10_000 }, rows: 24, buffer: { active: { type: 'normal', length: 24, baseY: 0, viewportY: 0 } },
    write(data, callback) { for (const byte of data) bytes.push(byte); if (delayWrites) pendingWrites.push(callback); else callback() },
    resize(cols, rows) { sizes.push([cols, rows]) }, reset: vi.fn(), scrollToLine: vi.fn() }
  const attach = vi.fn<AgentMuxHostedClient['reattachAgent']>().mockResolvedValue({ session: session(), attachment: initial })
  const replay = vi.fn<AgentMuxHostedClient['readRunReplay']>().mockResolvedValue(initial)
  const release = vi.fn<AgentMuxHostedClient['releaseRunAttachment']>().mockResolvedValue()
  const reader = createMobileTerminalReader({ client: { agentSession: () => sessionFact, onEvent: listener => {
    events.add(listener); return () => { events.delete(listener) }
  }, reattachAgent: attach, readRunReplay: replay, releaseRunAttachment: release }, agentSessionId: 'session-original', canvas,
  report: value => reports.push(value) })
  const emit = (event: AgentMuxClientEvent) => { for (const listener of events) listener(event) }
  const output = (startByte: number, dataBytes: Uint8Array, runId = 'run-original') => emit({ type: 'terminal-output', run: { runId }, agentSessionId: 'session-original', data: 'semantic must not be re-encoded', dataBytes,
    evidence: { source: 'terminal-output', observedAt: 1, outputByteRange: { startByte, endByte: startByte + dataBytes.length } } })
  return { reader, attach, replay, release, canvas, sizes, bytes, reports, events, pendingWrites, output, emit,
    setSession(value: typeof sessionFact) { sessionFact = value },
    delay() { delayWrites = true }, settle() { delayWrites = false; for (const callback of pendingWrites.splice(0)) callback() } }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
const settle = () => vi.advanceTimersByTimeAsync(20)

describe('original Run passive mobile reader', () => {
  it('keeps initial and confirmed healthy reading notice-free, including the normal alternate-buffer history boundary', async () => {
    const h = harness(snapshot(new Uint8Array(), { checkpoint: 0 }))
    expect(h.reports.at(-1)).toMatchObject({ phase: 'pending', notice: null })
    h.canvas.buffer.active.type = 'alternate'
    h.reader.setVisible(true); await settle()
    await vi.waitFor(() => expect(h.reports.at(-1)).toMatchObject({ phase: 'reading', notice: null, historyBoundary: expect.any(String) }))
    h.output(0, encode('healthy')); await settle()
    expect(h.reports.at(-1)?.notice).toBeNull()
    h.reader.setVisible(false); await settle()
    expect(h.reports.at(-1)).toMatchObject({ phase: 'paused', notice: null })
    await h.reader.dispose()
  })

  it('publishes unknown geometry while reading and clears it only after a trusted terminal continuation', async () => {
    const h = harness(snapshot(encode('raw'))); h.reader.setVisible(true); await settle()
    expect(h.reports.at(-1)).toMatchObject({ phase: 'reading', notice: expect.stringContaining('历史终端尺寸尚未核实') })
    const notice = h.reports.at(-1)!.notice
    h.output(3, encode('tail')); await settle()
    expect(h.reports.at(-1)?.notice).toBe(notice)
    h.replay.mockResolvedValueOnce(snapshot(new Uint8Array(), { checkpoint: 7 }))
    await h.reader.retry()
    expect(h.reports.at(-1)).toMatchObject({ phase: 'reading', notice: null })
    await h.reader.dispose()
  })

  it('keeps a handshake deadline notice through pending and transport restoration until that exact admission succeeds', async () => {
    const h = harness(), admission = deferred<Awaited<ReturnType<AgentMuxHostedClient['reattachAgent']>>>()
    h.attach.mockReturnValueOnce(admission.promise); h.reader.setVisible(true)
    await vi.advanceTimersByTimeAsync(6_100)
    expect(h.reports.at(-1)).toMatchObject({ phase: 'pending', notice: expect.stringContaining('握手仍未返回') })
    const notice = h.reports.at(-1)!.notice
    h.emit({ type: 'connection-state', state: 'restored', evidence: { source: 'user', observedAt: _newTailFixtureEpoch(0, 0, 1) } })
    expect(h.reports.at(-1)?.notice).toBe(notice)
    admission.resolve({ session: session(), attachment: snapshot(new Uint8Array(), { checkpoint: 0 }) }); await settle()
    expect(h.reports.at(-1)).toMatchObject({ phase: 'reading', notice: null })
    expect(h.attach.mock.calls).toEqual([['session-original', 0, 'terminal']])
    await h.reader.dispose()
  })

  it('uses raw split UTF-8 bytes and overlap suffixes, ignoring unrelated Run events and waiting for parser completion', async () => {
    const h = harness(); h.reader.setVisible(true); await settle()
    const word = encode('你好')
    h.delay(); h.output(0, word.subarray(0, 2)); await settle()
    expect(h.reader.facts().cursor).toBe(0)
    h.output(0, word.subarray(0, 4)); h.output(4, word.subarray(4)); h.output(6, encode('OTHER'), 'other-run')
    h.settle(); await settle()
    expect(h.bytes).toEqual([...word]); expect(new TextDecoder().decode(new Uint8Array(h.bytes))).toBe('你好')
    expect(h.reader.facts().cursor).toBe(6)
    expect(h.attach.mock.calls).toEqual([['session-original', 0, 'terminal']])
    expect(h.replay).not.toHaveBeenCalled()
    await h.reader.dispose(); expect(h.release.mock.calls).toEqual([[{ runId: 'run-original' }]])
  })

  it('separates synthetic restore length from original cursor and interleaves authoritative resizes inside replay bytes', async () => {
    const h = harness(snapshot(encode('abcd'), { checkpoint: 100, restore: 'synthetic screen seed', resizes: [{ throughByte: 102, resizeRevision: 1, size: { cols: 61, rows: 19 } }] }))
    h.delay(); h.reader.setVisible(true); await settle()
    expect(h.reader.facts().cursor).toBe(0); expect(h.pendingWrites.length).toBe(1)
    h.settle(); await vi.waitFor(() => expect(h.reader.facts().cursor).toBe(104))
    expect(h.sizes).toEqual([[80, 24], [61, 19]])
    expect(h.bytes).toEqual([...encode('synthetic screen seedabcd')])
    expect(h.reader.facts().resizeRevision).toBe(1)
    expect(h.reports.at(-1)?.message).toBe('已核实原会话的终端输出。原 Run 仍由 Mac Host 持有。')
    h.output(103, encode('de')); await settle(); expect(h.bytes).toEqual([...encode('synthetic screen seedabcde')])
    await h.reader.dispose()
  })

  it('validates the complete continuation before mutating a previously visible canvas', async () => {
    const h = harness(snapshot(encode('broken'), { checkpoint: 10 })); h.reader.setVisible(true); await settle()
    const invalid = snapshot(encode('bad'), { checkpoint: 20 }); invalid.resizeRevision = 2
    const original = [...h.bytes], resets = vi.mocked(h.canvas.reset).mock.calls.length
    h.emit({ type: 'terminal-snapshot', ...invalid, afterByte: 16 }); await settle()
    expect(h.bytes).toEqual(original); expect(vi.mocked(h.canvas.reset).mock.calls.length).toBe(resets)
    expect(h.reports.at(-1)?.message).toContain('未完成')
    expect(h.reports.at(-1)).toMatchObject({ phase: 'reading', notice: expect.stringContaining('未完成') })
    expect(h.reader.facts().cursor).toBe(16)
    const notice = h.reports.at(-1)!.notice
    h.output(16, encode('live')); await settle()
    h.emit({ type: 'connection-state', state: 'restored', evidence: { source: 'user', observedAt: _newTailFixtureEpoch(0, 0, 1) } })
    expect(h.reports.at(-1)?.notice).toBe(notice)
    h.replay.mockResolvedValueOnce(snapshot(new Uint8Array(), { checkpoint: 20 })); await h.reader.retry()
    expect(h.reports.at(-1)).toMatchObject({ phase: 'reading', notice: null })
    await h.reader.dispose()
  })

  it('releases a late attachment exactly once after close and never hydrates the abandoned canvas', async () => {
    const h = harness(), admission = deferred<Awaited<ReturnType<AgentMuxHostedClient['reattachAgent']>>>()
    h.attach.mockReturnValueOnce(admission.promise); h.reader.setVisible(true); await settle()
    const closing = h.reader.dispose()
    expect(h.events.size).toBe(0); expect(h.release).not.toHaveBeenCalled()
    admission.resolve({ session: session(), attachment: snapshot(encode('late bytes')) }); await closing
    expect(h.release.mock.calls).toEqual([[{ runId: 'run-original' }]])
    expect(h.bytes).toEqual([]); expect(h.reader.facts().acquired).toBeNull()
  })

  it('serializes hidden→visible transitions around one pending admission and closes only its own Run lease', async () => {
    const h = harness(), admission = deferred<Awaited<ReturnType<AgentMuxHostedClient['reattachAgent']>>>()
    h.attach.mockReturnValueOnce(admission.promise); h.reader.setVisible(true); await settle()
    h.reader.setVisible(false); h.reader.setVisible(true)
    expect(h.attach.mock.calls).toEqual([['session-original', 0, 'terminal']])
    admission.resolve({ session: session(), attachment: snapshot(encode('still-original')) }); await settle()
    expect(new TextDecoder().decode(new Uint8Array(h.bytes))).toBe('still-original')
    h.reader.setVisible(false); await settle()
    expect(h.release.mock.calls).toEqual([[{ runId: 'run-original' }]])
    h.reader.setVisible(true); await settle(); expect(h.attach.mock.calls.length).toBe(2)
    await h.reader.dispose(); expect(h.release.mock.calls).toEqual([[{ runId: 'run-original' }], [{ runId: 'run-original' }]])
  })

  it('bounds paused-parser work and recovers the missing raw range from the original parsed cursor', async () => {
    const h = harness(); h.reader.setVisible(true); await settle(); h.delay()
    h.output(0, encode('first')); await settle()
    const block = new Uint8Array(128 * 1024).fill(120)
    for (let index = 0; index < 24; index++) h.output(5 + index * block.length, block)
    expect(h.reader.facts().queuedItems).toBeLessThanOrEqual(16)
    const end = 5 + 24 * block.length
    h.replay.mockResolvedValue(snapshot(new Uint8Array(end - 5).fill(120), { start: 5 }))
    h.settle(); await vi.waitFor(() => expect(h.reader.facts().cursor).toBe(end))
    expect(h.replay.mock.calls).toEqual([[{ runId: 'run-original' }, 5, 'terminal']])
    expect(h.reader.facts().cursor).toBe(end)
    expect(h.bytes.length).toBe(end); expect(h.bytes.slice(0, 5)).toEqual([...encode('first')])
    await h.reader.dispose()
  })

  it('isolates a Core-confirmed new Run on the same Session from old cursor, queued bytes and in-flight parser work', async () => {
    const h = harness(snapshot(encode('OLD'))); h.reader.setVisible(true); await settle()
    h.delay(); h.output(3, encode('in-flight')); await settle(); h.output(12, encode('QUEUED-OLD'))
    h.reader.setVisible(false); await settle()
    const nextSession = { ...session(), run: { runId: 'confirmed-new-run' } }
    h.setSession(nextSession)
    const nextSnapshot = snapshot(encode('NEW'), { checkpoint: 0 })
    nextSnapshot.run.runId = 'confirmed-new-run'
    if (nextSnapshot.terminal.type === 'basic-vt') nextSnapshot.terminal.checkpoint.runId = 'confirmed-new-run'
    h.attach.mockResolvedValueOnce({ session: nextSession, attachment: nextSnapshot })
    h.reader.setVisible(true); await settle()
    expect(h.attach.mock.calls).toEqual([['session-original', 0, 'terminal']])
    h.settle(); await vi.waitFor(() => expect(new TextDecoder().decode(new Uint8Array(h.bytes))).toBe('OLDin-flight\x1b[0mNEW'))
    expect(h.attach.mock.calls).toEqual([['session-original', 0, 'terminal'], ['session-original', 0, 'terminal']])
    expect(h.reader.facts().cursor).toBe(3); expect(h.reader.facts().queuedItems).toBe(0)
    expect(new TextDecoder().decode(new Uint8Array(h.bytes))).toBe('OLDin-flight\x1b[0mNEW')
    await h.reader.dispose()
    expect(h.release.mock.calls).toEqual([[{ runId: 'run-original' }], [{ runId: 'confirmed-new-run' }]])
  })

  it('keeps new output readable after a recovery deadline and restored connection alone does not claim authoritative health', async () => {
    const h = harness(); h.reader.setVisible(true); await settle()
    const read = deferred<AgentMuxRunAttachment>(); h.replay.mockReturnValueOnce(read.promise)
    h.output(10, encode('new')); await vi.advanceTimersByTimeAsync(6_100)
    expect(h.reader.facts().cursor).toBe(13); expect(h.bytes).toEqual([...encode('new')])
    h.output(13, encode('still')); await settle(); expect(h.reader.facts().cursor).toBe(18)
    expect(h.replay.mock.calls).toEqual([[{ runId: 'run-original' }, 0, 'terminal']])
    const current = h.reports.at(-1)!.message
    h.emit({ type: 'connection-state', state: 'restored', evidence: { source: 'user', observedAt: 1 } }); await settle()
    expect(h.reports.at(-1)!.message).toBe(current)
    read.resolve(snapshot(encode('old'))); await settle(); expect(h.bytes).toEqual([...encode('newstill')])
    await h.reader.dispose()
  })

  it('consumes the SDK authoritative reconnect snapshot and reads unknown missing output from parser cursor, not observed afterByte', async () => {
    const h = harness(snapshot(new Uint8Array(), { checkpoint: 0 })); h.reader.setVisible(true); await settle(); h.output(0, encode('original')); await settle()
    h.emit({ type: 'connection-state', state: 'lost', evidence: { source: 'user', observedAt: 1 } })
    expect(h.reports.at(-1)).toMatchObject({ phase: 'reading', notice: expect.stringContaining('Host 输出连接尚未恢复') })
    const recovered = snapshot(encode('missed output'), { start: 8 })
    recovered.terminal = { type: 'unknown', reason: 'origin_unknown' }
    h.replay.mockResolvedValueOnce(recovered)
    h.emit({ type: 'terminal-snapshot', ...recovered, afterByte: 21 })
    await settle()
    expect(h.replay.mock.calls).toEqual([[{ runId: 'run-original' }, 8, 'terminal']])
    expect(h.reader.facts().cursor).toBe(21)
    expect(new TextDecoder().decode(new Uint8Array(h.bytes))).toBe('\x1b[0moriginalmissed output')
    expect(h.reports.at(-1)?.message).toContain('历史终端尺寸尚未核实')
    expect(h.reports.at(-1)?.notice).toContain('历史终端尺寸尚未核实')
    await h.reader.dispose()
  })

  it('keeps a missing-output notice on new live bytes until a trusted snapshot repairs the original projection', async () => {
    const h = harness(snapshot(new Uint8Array(), { checkpoint: 0 })); h.reader.setVisible(true); await settle()
    h.replay.mockRejectedValueOnce(new Error('Original replay temporarily unavailable'))
    h.output(10, encode('new')); await settle()
    expect(h.reports.at(-1)).toMatchObject({ phase: 'reading', notice: expect.stringContaining('未恢复区间') })
    const notice = h.reports.at(-1)!.notice
    h.output(13, encode('tail')); await settle()
    expect(h.reports.at(-1)?.notice).toBe(notice)
    expect(h.reader.facts().cursor).toBe(17)
    h.replay.mockResolvedValueOnce(snapshot(new Uint8Array(), { checkpoint: 17 })); await h.reader.retry()
    expect(h.reports.at(-1)).toMatchObject({ phase: 'reading', notice: null })
    expect(h.replay.mock.calls).toEqual([[{ runId: 'run-original' }, 0, 'terminal'], [{ runId: 'run-original' }, 17, 'terminal']])
    await h.reader.dispose()
  })

  it('does not clear a confirmed replacement-Run notice with an otherwise valid old-Run snapshot', async () => {
    const h = harness(snapshot(encode('OLD'), { checkpoint: 0 })); h.reader.setVisible(true); await settle()
    await vi.waitFor(() => expect(h.reports.at(-1)?.phase).toBe('reading'))
    const nextSession = { ...session(), run: { runId: 'confirmed-new-run' } }; h.setSession(nextSession)
    h.emit({ type: 'agent-session', session: nextSession })
    const notice = h.reports.at(-1)!.notice
    expect(notice).toContain('画面来自上一个 Run')
    h.emit({ type: 'terminal-snapshot', ...snapshot(new Uint8Array(), { checkpoint: 3 }), afterByte: 3 }); await settle()
    await vi.waitFor(() => expect(h.reports.at(-1)?.message).toContain('已核实原会话的终端输出'))
    expect(h.reports.at(-1)).toMatchObject({ phase: 'reading', notice })
    const nextSnapshot = snapshot(encode('NEW'), { checkpoint: 0 }); nextSnapshot.run.runId = 'confirmed-new-run'
    if (nextSnapshot.terminal.type === 'basic-vt') nextSnapshot.terminal.checkpoint.runId = 'confirmed-new-run'
    h.attach.mockResolvedValueOnce({ session: nextSession, attachment: nextSnapshot }); await h.reader.retry()
    expect(h.reports.at(-1)).toMatchObject({ phase: 'reading', notice: null })
    expect(h.reader.facts().acquired).toEqual({ runId: 'confirmed-new-run' })
    await h.reader.dispose()
  })

  it('keeps the prior canvas until explicit retry after Core confirms a new Run, then reads that exact new scope from zero', async () => {
    const h = harness(snapshot(encode('OLD'))); h.reader.setVisible(true); await settle()
    const oldRead = deferred<AgentMuxRunAttachment>(); h.replay.mockReturnValueOnce(oldRead.promise)
    h.output(10, encode('old-tail')); await vi.advanceTimersByTimeAsync(6_100)
    const nextSession = { ...session(), run: { runId: 'confirmed-new-run' } }; h.setSession(nextSession)
    h.emit({ type: 'agent-session', session: nextSession })
    expect(h.reports.at(-1)?.message).toContain('画面来自上一个 Run')
    expect(h.reader.facts().cursor).toBe(18)
    const nextSnapshot = snapshot(encode('NEW')); nextSnapshot.run.runId = 'confirmed-new-run'
    h.attach.mockResolvedValueOnce({ session: nextSession, attachment: nextSnapshot })
    const retry = h.reader.retry(); await settle(); await retry
    expect(h.attach.mock.calls).toEqual([['session-original', 0, 'terminal'], ['session-original', 0, 'terminal']])
    expect(h.reader.facts().cursor).toBe(3)
    expect(h.reports.at(-1)?.message).toContain('历史终端尺寸尚未核实')
    const newRead = snapshot(encode('xyABC'), { start: 3 }); newRead.run.runId = 'confirmed-new-run'
    h.replay.mockResolvedValueOnce(newRead)
    h.emit({ type: 'terminal-output', run: nextSession.run, agentSessionId: nextSession.agentSessionId, data: '', dataBytes: encode('ABC'),
      evidence: { source: 'terminal-output', observedAt: 1, outputByteRange: { startByte: 5, endByte: 8 } } })
    await settle()
    expect(h.replay.mock.calls).toEqual([[{ runId: 'run-original' }, 3, 'terminal'], [{ runId: 'confirmed-new-run' }, 3, 'terminal']])
    expect(h.reader.facts().cursor).toBe(8)
    oldRead.resolve(snapshot(encode('late-old-replay'))); await settle()
    expect(h.reader.facts().cursor).toBe(8)
    expect(new TextDecoder().decode(new Uint8Array(h.bytes))).toBe('OLDold-tailNEWxyABC')
    await h.reader.dispose()
    expect(h.release.mock.calls).toEqual([[{ runId: 'run-original' }], [{ runId: 'confirmed-new-run' }]])
  })
})
