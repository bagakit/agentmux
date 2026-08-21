import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import headless from '@xterm/headless'
import { TerminalViewportSynchronizer } from '../src/renderer/src/lib/terminal-viewport-sync'
import { admitTerminalLiveOutput, composeTerminalLiveOutputWrite, takeTerminalLiveOutputBatch, type TerminalLiveItem } from '../src/renderer/src/lib/terminal-live-output'

function harness() {
  const terminal = new headless.Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  let pixels = { width: 800, height: 480 }
  let proposal = { cols: 80, rows: 24 }
  const frames = new Map<number, FrameRequestCallback>()
  let next = 0
  const resize = vi.fn(async (size: { cols: number; rows: number }) => size)
  const sync = new TerminalViewportSynchronizer({
    proposeGrid: () => proposal,
    readGrid: () => ({ cols: terminal.cols, rows: terminal.rows }),
    fit: () => terminal.resize(proposal.cols, proposal.rows),
    applyOwnerGrid: ({ cols, rows }) => terminal.resize(cols, rows),
    resize,
    measureViewport: () => pixels,
    requestFrame: (frame) => { frames.set(++next, frame); return next },
    cancelFrame: (id) => { frames.delete(id) }
  })
  return {
    terminal, sync, resize,
    changeLayout: () => { proposal = { cols: 100, rows: 30 }; pixels = { width: 1000, height: 600 } },
    async flush() {
      for (const [id, frame] of frames) { frames.delete(id); frame(0) }
      await Promise.resolve(); await Promise.resolve()
    },
    dispose() { sync.dispose(); terminal.dispose() }
  }
}

describe('long-lived View follows its PTY owner', () => {
  it('orders old bytes, owner geometry, then new bytes without competing resize requests', async () => {
    const h = harness()
    try {
      await h.sync.startLiveSynchronization()
      const old = '\x1b[?1049h\x1b[24;1HOLD'
      const wide = '\x1b[40;100HWIDE_MARK'
      const input: TerminalLiveItem[] = [
        { data: old, startByte: 0, endByte: old.length },
        { size: { cols: 132, rows: 45 } },
        { data: wide, startByte: old.length, endByte: old.length + wide.length }
      ]
      let queue: TerminalLiveItem[] = []
      for (const item of input) queue = admitTerminalLiveOutput(queue, item).queue
      let cursor = 0
      const order: string[] = []
      while (queue.length) {
        const taken = takeTerminalLiveOutputBatch(queue)
        queue = taken.rest
        if (taken.size) { h.sync.acceptOwnerSize(taken.size); order.push('132x45'); continue }
        const composed = composeTerminalLiveOutputWrite(taken.batch, cursor)
        await new Promise<void>((resolve) => h.terminal.write(composed.data, resolve))
        cursor = composed.cursor
        order.push(composed.data)
      }
      expect(order).toEqual([old, '132x45', wide])
      expect(h.terminal.buffer.active.getLine(23)?.translateToString(true)).toBe('OLD')
      expect(h.terminal.buffer.active.getLine(39)?.translateToString(true)).toBe(`${' '.repeat(99)}WIDE_MARK`)
      h.sync.observeViewport()
      await h.flush()
      expect([h.terminal.cols, h.terminal.rows]).toEqual([132, 45])
      expect(h.resize.mock.calls).toEqual([[{ cols: 80, rows: 24 }]])
      h.changeLayout()
      h.sync.observeViewport()
      await h.flush()
      expect(h.resize).toHaveBeenLastCalledWith({ cols: 100, rows: 30 })
      expect([h.terminal.cols, h.terminal.rows]).toEqual([100, 30])
    } finally { h.dispose() }
  })

  it('hidden views follow owner facts passively, then reclaim the local viewport when revealed', async () => {
    const h = harness()
    try {
      await h.sync.startLiveSynchronization()
      h.sync.setVisible(false)
      h.sync.acceptOwnerSize({ cols: 132, rows: 45 })
      expect([h.terminal.cols, h.terminal.rows]).toEqual([132, 45])
      expect(h.resize).toHaveBeenCalledTimes(1)
      h.sync.setVisible(true)
      await h.flush()
      expect([h.terminal.cols, h.terminal.rows]).toEqual([80, 24])
      expect(h.resize).toHaveBeenCalledTimes(2)
    } finally { h.dispose() }
  })

  it('invalid geometry cannot disturb a working parser or request another resize', async () => {
    const h = harness()
    try {
      await h.sync.startLiveSynchronization()
      h.sync.acceptOwnerSize({ cols: 0, rows: 45 })
      expect([h.terminal.cols, h.terminal.rows]).toEqual([80, 24])
      expect(h.resize).toHaveBeenCalledTimes(1)
    } finally { h.dispose() }
  })

  it('keeps the geometry of retained bytes when bounded backlog drops an older prefix', () => {
    const old = { data: 'old!', startByte: 0, endByte: 4 }
    const size = { size: { cols: 132, rows: 45 } }
    const recent = { data: 'new!', startByte: 4, endByte: 8 }
    expect(admitTerminalLiveOutput<TerminalLiveItem>([size, old], recent, 4)).toEqual({ queue: [size, recent], droppedBytes: 4 })
    expect(admitTerminalLiveOutput<TerminalLiveItem>([size], { size: { cols: 100, rows: 30 } }).queue).toEqual([{ size: { cols: 100, rows: 30 } }])
  })

  it('the actual TerminalView accepts only its Run and Host, and consumes geometry on the output drain', () => {
    const source = readFileSync(new URL('../src/renderer/src/components/TerminalView.tsx', import.meta.url), 'utf8')
    const start = source.indexOf('const accept = (event: RuntimeEvent)')
    const end = source.indexOf('const disposeEvents', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const accept = source.slice(start, end)
    expect(accept).toContain("event.hostId === session.hostId && core.type === 'terminal-resized'")
    expect(accept).toContain('core.run.runId === session.control.run.runId')
    expect(accept).toContain('if (size) scheduleLiveOutputDrain({ size })')
    expect(source).toContain('applyOwnerGrid: ({ cols, rows }) => terminal.resize(cols, rows)')
    expect(source).toContain('viewport.acceptOwnerSize(taken.size)')
    expect(source).toContain('if (droppedPendingSize) scheduleLiveOutputDrain({ size: droppedPendingSize })')
  })
})
