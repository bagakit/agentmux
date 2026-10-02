import type { AgentMuxClientEvent, AgentMuxRunAttachment, AgentMuxRunRef } from '@agentmux/core'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { terminalContinuationSteps } from '@agentmux/core/terminal-continuation'
import { TerminalLiveOutputQueue, composeTerminalLiveOutputWrite } from '@agentmux/client-ui/terminal/live-output'
import { hydrateTerminalReplay, restoreTerminalCheckpoint, terminalHistoryBoundary, yieldTerminalWork } from '@agentmux/client-ui/terminal/replay'

export type MobileTerminalCanvas = {
  options: { scrollback?: number }
  write(data: Uint8Array, callback: () => void): void
  reset(): void
  resize(cols: number, rows: number): void
  scrollToLine(line: number): void
  readonly rows: number
  readonly buffer: { active: { type: 'normal' | 'alternate'; length: number; baseY: number; viewportY: number } }
}
export type MobileTerminalReading = { phase: 'pending' | 'reading' | 'paused' | 'unavailable'; message: string; historyBoundary: string | null }
type ReaderClient = Pick<AgentMuxHostedClient, 'agentSession' | 'onEvent' | 'reattachAgent' | 'readRunReplay' | 'releaseRunAttachment'>
const DEADLINE_MS = 6_000
const sameRun = (left: AgentMuxRunRef, right: AgentMuxRunRef) => left.runId === right.runId

/** One passive parser and one consumer's observation. No process, Input or PTY-size methods exist on this port. */
export function createMobileTerminalReader({ client, agentSessionId, canvas, report, scrollback = 10_000 }: {
  client: ReaderClient; agentSessionId: string; canvas: MobileTerminalCanvas
  report(reading: MobileTerminalReading): void; scrollback?: number
}) {
  let queue = new TerminalLiveOutputQueue()
  let visible = false, closed = false, ready = false, draining = false
  let visibilityRevision = 0
  let cursor = 0, resizeRevision = 0
  let expected: AgentMuxRunRef | null = null, acquired: AgentMuxRunRef | null = null
  let transition: Promise<void> | null = null, pendingRead: Promise<AgentMuxRunAttachment> | null = null
  let activeDrain: Promise<void> | null = null
  let omitted = false, geometryKnown = false
  let scheduled: ReturnType<typeof setTimeout> | null = null
  const writes = new Set<() => void>()
  let reading: MobileTerminalReading = { phase: 'pending', message: '正在核实原会话的终端输出。运行状态尚未确认。', historyBoundary: null }
  const publish = (change: Partial<MobileTerminalReading>) => {
    if (closed) return
    const next = { ...reading, ...change }
    if (next.phase !== reading.phase || next.message !== reading.message || next.historyBoundary !== reading.historyBoundary) { reading = next; report(reading) }
  }
  const boundary = () => publish({ historyBoundary: terminalHistoryBoundary(canvas.buffer.active, canvas.rows, scrollback) })
  const write = (bytes: Uint8Array) => new Promise<void>(resolve => {
    if (closed || bytes.byteLength === 0) return resolve()
    const settled = () => { writes.delete(settled); resolve() }
    writes.add(settled)
    canvas.write(bytes, settled)
  })
  const problem = (step: string, error: unknown) => publish({
    phase: ready ? 'reading' : 'unavailable',
    message: `${step}未完成；原画面和会话引用仍保留，运行状态未据此判为退出。${error instanceof Error ? error.message : String(error)}`
  })

  async function applySnapshot(snapshot: AgentMuxRunAttachment) {
    if (!expected || !sameRun(snapshot.run, expected) || snapshot.run.agentSessionId !== agentSessionId) throw new Error('返回的输出不属于原会话和 Run。')
    // Exhaust validation before touching the canvas. A synthetic seed never acknowledges its encoded length.
    const steps = [...terminalContinuationSteps(snapshot)]
    const distance = canvas.buffer.active.baseY - canvas.buffer.active.viewportY
    const known = snapshot.terminal.type === 'basic-vt'
    if (!known) geometryKnown = false
    if (!known && snapshot.gap) {
      omitted = true
      cursor = Math.max(cursor, snapshot.gap.firstAvailableByte)
    }
    for (const step of steps) {
      if (closed) return
      if (step.type === 'restore') {
        const checkpoint = step.checkpoint
        const scrollback = canvas.options.scrollback!
        canvas.reset()
        canvas.resize(checkpoint.restoreSize.cols, checkpoint.restoreSize.rows)
        if (checkpoint.restoreScrollbackRows !== null) canvas.options.scrollback = checkpoint.restoreScrollbackRows
        try {
          await restoreTerminalCheckpoint(step.restoreBytes.subarray(0, checkpoint.resizeAfterRestoreBytes), write)
          if (closed) return
          if (checkpoint.size.cols !== checkpoint.restoreSize.cols || checkpoint.size.rows !== checkpoint.restoreSize.rows) {
            canvas.resize(checkpoint.size.cols, checkpoint.size.rows)
          }
          await restoreTerminalCheckpoint(step.restoreBytes.subarray(checkpoint.resizeAfterRestoreBytes), write)
        } finally {
          canvas.options.scrollback = scrollback
        }
        if (closed) return
        cursor = step.checkpoint.throughByte
        resizeRevision = step.checkpoint.resizeRevision
        geometryKnown = true
      } else if (step.type === 'resized') {
        canvas.resize(step.size.cols, step.size.rows)
        resizeRevision = step.resizeRevision
      } else {
        const composed = composeTerminalLiveOutputWrite([step], cursor)
        omitted ||= composed.gap
        await hydrateTerminalReplay(composed.dataBytes.byteLength ? [{ dataBytes: composed.dataBytes, endByte: composed.cursor }] : [], write)
        if (closed) return
        cursor = composed.cursor
      }
    }
    if (closed) return
    if (known && distance > 0) canvas.scrollToLine(Math.max(0, canvas.buffer.active.baseY - distance))
    ready = true
    publish({ phase: 'reading', message: omitted ? '部分原始输出未能恢复。当前画面继续阅读；可重新核实输出，Mac 上的输入与运行不受影响。'
      : !geometryKnown ? '正在阅读原始输出；历史终端尺寸尚未核实，画面采用本机阅读网格。Mac 的运行与尺寸保持不变。'
        : '已核实原会话的终端输出。原 Run 仍由 Mac Host 持有。' })
    boundary()
  }

  async function recover(throughByte: number): Promise<boolean> {
    if (!expected || pendingRead) return false
    const run = { ...expected }
    const operation = client.readRunReplay(run, cursor, 'terminal')
    pendingRead = operation
    void operation.finally(() => { if (pendingRead === operation) pendingRead = null }).catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const snapshot = await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('保留输出读取仍未返回；当前观察不因此停止。')), DEADLINE_MS)
      })])
      if (closed) return false
      await applySnapshot(snapshot)
      return cursor >= throughByte
    } catch (error) { if (!closed) { omitted = true; problem('保留输出读取', error) }; return false }
    finally { clearTimeout(timer) }
  }

  function schedule() {
    if (closed || !visible || !ready || draining || scheduled !== null || !queue.length) return
    scheduled = setTimeout(() => {
      scheduled = null
      const operation = drain(); activeDrain = operation
      void operation.finally(() => { if (activeDrain === operation) activeDrain = null })
    }, 0)
  }
  async function drain() {
    if (draining || closed || !visible || !ready) return
    draining = true
    try {
      while (!closed && visible && ready && queue.length) {
        const item = queue.take()
        if (item.snapshot) {
          const snapshot = item.snapshot.snapshot
          if (snapshot.terminal.type !== 'basic-vt' && snapshot.run.latestOutputBytes > cursor) {
            // The shared queue keeps unknown continuation metadata only. Read missing original
            // bytes from our parser cursor, never the SDK's observed/publication cursor.
            if (!await recover(snapshot.run.latestOutputBytes)) problem('输出恢复核实', new Error('原字节区间尚未完整恢复；当前画面保留。'))
          } else await applySnapshot(snapshot)
          continue
        }
        if (item.resize) {
          const resize = item.resize
          if (resize.resizeRevision <= resizeRevision) continue
          if (resize.throughByte > cursor) await recover(resize.throughByte)
          if (closed) return
          if (resize.resizeRevision !== resizeRevision + 1 || resize.throughByte !== cursor) {
            omitted = true; geometryKnown = false
            problem('终端尺寸顺序核实', new Error('历史字节或尺寸发生缺口；本机画面只反映已收到的输出。'))
          }
          canvas.resize(resize.size.cols, resize.size.rows)
          resizeRevision = resize.resizeRevision
        } else {
          let composed = composeTerminalLiveOutputWrite(item.batch, cursor)
          if (composed.gap) { await recover(composed.cursor); composed = composeTerminalLiveOutputWrite(item.batch, cursor) }
          if (closed) return
          if (composed.gap) { omitted = true; problem('输出连续性核实', new Error('原始字节存在未恢复区间，当前新输出仍可阅读。')) }
          await write(composed.dataBytes)
          if (closed) return
          cursor = composed.cursor
        }
        boundary()
        await yieldTerminalWork()
      }
    } catch (error) { problem('终端画面恢复', error) }
    finally { draining = false; schedule() }
  }
  function accept(event: AgentMuxClientEvent) {
    if (closed || !visible || !expected) return
    if (event.type === 'connection-state') {
      if (event.state !== 'restored') publish({ message: 'Host 输出连接尚未恢复。原画面与会话保留；当前 Run 状态未知，可重新核实输出。' })
      return
    }
    if (event.type === 'agent-session' && event.session.agentSessionId === agentSessionId && !sameRun(event.session.run, expected)) {
      publish({ message: 'Core 已确认同一会话换成新的 Run。当前画面来自上一个 Run；请重新核实输出，原运行不因此受控。' })
      return
    }
    if (!('run' in event) || !event.run || !sameRun(event.run, expected) || 'agentSessionId' in event && event.agentSessionId && event.agentSessionId !== agentSessionId) return
    if (event.type === 'terminal-output') queue.admit({ ...event.evidence.outputByteRange, dataBytes: event.dataBytes })
    else if (event.type === 'terminal-resized') queue.admit({ size: { cols: event.cols, rows: event.rows }, throughByte: event.throughByte, resizeRevision: event.resizeRevision })
    else if (event.type === 'terminal-snapshot') queue.admitSnapshot(event)
    else return
    schedule()
  }
  const unlisten = client.onEvent(accept)

  function reconcile(): Promise<void> {
    if (transition) return transition
    const revision = visibilityRevision
    const operation = (async () => {
      if (acquired && (!visible || closed)) {
        const release = acquired; acquired = null; ready = false
        await client.releaseRunAttachment(release)
      }
      if (closed || !visible || acquired) return
      const next = client.agentSession(agentSessionId).run
      if (expected && !sameRun(expected, next)) {
        // Core confirmed a different Run on this same Session. Finish the sole in-flight
        // parser write before resetting; queued bytes and cursors belong only to the old Run.
        ready = false
        await activeDrain
        if (closed || !visible) return
        queue = new TerminalLiveOutputQueue()
        pendingRead = null
        cursor = resizeRevision = 0; geometryKnown = omitted = false
        canvas.reset()
      }
      expected = { ...client.agentSession(agentSessionId).run }
      publish({ phase: 'pending', message: '正在核实原会话的终端输出。运行状态尚未确认。' })
      const timer = setTimeout(() => publish({ message: '终端输出握手仍未返回。原画面与会话引用保留；Mac 的输入与运行不因此停止。' }), DEADLINE_MS)
      try {
        const result = await client.reattachAgent(agentSessionId, cursor, 'terminal')
        if (result.session.agentSessionId !== agentSessionId || !sameRun(result.attachment.run, expected)) throw new Error('握手返回了另一会话或 Run。')
        acquired = { ...expected }
        if (!visible || closed) {
          const release = acquired; acquired = null
          await client.releaseRunAttachment(release)
          return
        }
        await applySnapshot(result.attachment)
      } finally { clearTimeout(timer) }
    })().catch(error => { problem('终端观察握手', error) }).finally(() => {
      if (transition === operation) transition = null
      if (acquired && (!visible || closed) || !closed && visible && !acquired && revision !== visibilityRevision) void reconcile()
      else schedule()
    })
    transition = operation
    return operation
  }
  report(reading)
  return {
    setVisible(value: boolean) {
      if (visible === value) return
      visibilityRevision += 1
      visible = value
      if (!value) publish({ phase: 'paused', message: '终端阅读已暂停；原会话仍由 Mac 管理。' })
      void reconcile()
    },
    async retry() {
      if (closed || transition || !visible) return
      try {
        if (acquired && !sameRun(client.agentSession(agentSessionId).run, acquired)) {
          const previous = acquired
          await client.releaseRunAttachment(previous)
          acquired = null; ready = false
        }
        if (!acquired) await reconcile()
        else if (!pendingRead) { await recover(cursor); schedule() }
      } catch (error) { problem('原会话输出重新核实', error) }
    },
    facts: () => ({ cursor, resizeRevision, queuedItems: queue.length, acquired: acquired ? { ...acquired } : null }),
    async dispose() {
      if (closed) { await transition; return }
      closed = true; visible = false; unlisten(); clearTimeout(scheduled ?? undefined)
      for (const settle of writes) settle()
      await transition
      await reconcile()
    }
  }
}
