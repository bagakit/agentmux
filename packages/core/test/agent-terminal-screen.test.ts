import { describe, expect, it } from 'vitest'
import {
  AgentTerminalScreen,
  AgentTerminalScreenEvidence
} from '../src/agent-terminal-screen.js'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import type { CtxmuxAdapterObservationEvent, CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

const encoder = new TextEncoder()

async function write(screen: AgentTerminalScreen, data: string): Promise<void> {
  const dataBytes = encoder.encode(data)
  await screen.write({
    startByte: screen.throughByte,
    endByte: screen.throughByte + dataBytes.byteLength,
    dataBytes
  })
}

describe('AgentTerminalScreen', () => {
  it('tracks the active composer across partial synchronized updates', async () => {
    const screen = new AgentTerminalScreen(80, 24)
    try {
      await write(screen, '\u001b[22;1H› \u001b[22;3H')
      expect(screen.composerText('›')).toBe('')

      await write(screen, '\u001b[?2026h\u001b[22;3H/exit\u001b[22;8H\u001b[?2026l')
      expect(screen.composerText('›')).toBe('/exit')
    } finally {
      screen.dispose()
    }
  })

  it('does not confuse assistant text or a full-screen historical redraw with composer input', async () => {
    const screen = new AgentTerminalScreen(80, 24)
    try {
      await write(screen, '\u001b[5;1H› assistant repeated /exit\u001b[22;1Hstatus\u001b[22;7H')
      expect(screen.composerText('›')).toBeNull()

      await write(screen, '\u001b[2J\u001b[5;1Hassistant repeated /exit\u001b[22;1H› \u001b[22;3H')
      expect(screen.composerText('›')).toBe('')
    } finally {
      screen.dispose()
    }
  })

  it('preserves explicit line breaks separately from terminal soft wrapping', async () => {
    const screen = new AgentTerminalScreen(80, 24)
    try {
      await write(screen, '\u001b[22;1H› line1\r\nline2')
      expect(screen.composerText('›')).toBeNull()
      expect(screen.composerText('›', true)).toBe('line1\nline2')
    } finally {
      screen.dispose()
    }
  })

  it('retains a composer marker after a long prompt scrolls beyond the viewport', async () => {
    const screen = new AgentTerminalScreen(10, 3)
    const prompt = 'x'.repeat(40)
    try {
      await write(screen, `› ${prompt}`)
      expect(screen.composerText('›')).toBe(prompt)
    } finally {
      screen.dispose()
    }
  })

  it('preserves intentional spaces around explicit line breaks', async () => {
    const screen = new AgentTerminalScreen(80, 24)
    try {
      await write(screen, '› line1  \r\n  line2')
      expect(screen.composerText('›', true)).toBe('line1  \n  line2')
    } finally {
      screen.dispose()
    }
  })

  it('fails closed on a missing or overlapping byte range', async () => {
    const screen = new AgentTerminalScreen(80, 24)
    try {
      await write(screen, 'ok')
      await expect(screen.write({
        startByte: 3,
        endByte: 4,
        dataBytes: encoder.encode('x')
      })).rejects.toMatchObject({ code: 'OUTPUT_GAP' })
      await expect(screen.write({
        startByte: 1,
        endByte: 3,
        dataBytes: encoder.encode('xy')
      })).rejects.toMatchObject({ code: 'OUTPUT_GAP' })
      await expect(screen.write({
        startByte: 0,
        endByte: 2,
        dataBytes: encoder.encode('ok')
      })).rejects.toMatchObject({ code: 'OUTPUT_GAP' })
    } finally {
      screen.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// f-23q8faabh / T-002：有界增量屏幕证据。同一 Session 的提交/readiness 观察共享一份长命
// 增量屏幕：已消费的前缀不再从 byte 0 重放，重放字节量相对会话历史长度有界；gap 失效后
// 重建仍能正确判定 composer。
// ---------------------------------------------------------------------------

const FRAME_START = '\u001b[?2026h'
const FRAME_END = '\u001b[?2026l'

function evidenceChunk(evidence: AgentTerminalScreenEvidence, data: string): void {
  const dataBytes = encoder.encode(data)
  evidence.accept({
    type: 'data',
    startByte: evidence.throughByte,
    endByte: evidence.throughByte + dataBytes.byteLength,
    dataBytes
  })
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10))
}

describe('AgentTerminalScreenEvidence 帧游标', () => {
  it('boundary 之前完成的帧不算数，boundary 之后的完整帧才放行', async () => {
    const evidence = new AgentTerminalScreenEvidence(80, 24, { start: FRAME_START, end: FRAME_END })
    try {
      const firstFrame = `${FRAME_START}\u001b[22;1H› \u001b[22;3H${FRAME_END}`
      const boundary = encoder.encode(firstFrame).byteLength
      evidenceChunk(evidence, firstFrame)
      await settle()
      expect(evidence.lastCompleteFrame).toEqual({ startByte: 0, endByte: boundary })

      let ready = false
      const waiting = evidence.wait({
        boundaryByte: boundary,
        requireOutputAfterBoundary: true,
        requireFrameAfterBoundary: true,
        predicate: (screen) => screen.composerText('›') === '',
        timeoutMessage: 'fixture timeout',
        terminalMessage: 'fixture exit'
      }).then((throughByte) => {
        ready = true
        return throughByte
      })
      await settle()
      // 第一帧完成于 boundary 之前：即便 composer 已空，也不许用它当作 boundary 之后的证据。
      expect(ready).toBe(false)

      evidenceChunk(evidence, `${FRAME_START}\u001b[22;3H${FRAME_END}`)
      await expect(waiting).resolves.toBeGreaterThan(boundary)
      expect(evidence.lastCompleteFrame?.startByte).toBe(boundary)
    } finally {
      evidence.dispose()
    }
  })

  // -------------------------------------------------------------------------
  // 上面那条把两个守卫**同时**置为假（第一帧完成于 boundary 之前 ⇒ frameObserved 假；
  // throughByte 恰好等于 boundary ⇒ crossedBoundary 假），于是两个守卫互相掩盖：实测单独
  // 放宽任何一个（把 `requireOutputAfterBoundary` 的 `>` 改成 `>=`／让 frameObserved 恒真），
  // 这个文件 10 条全绿。生产里两个开关又恰好总是成对——`prompt-submission.ts` 的
  // observeReadiness 只在 `initial-composer` 那一支同时给两个 true——所以一个 fixture 很容易
  // 把两件事当成一件。
  //
  // 下面两条各只留一个守卫在场。它们守的不是同一个事实：
  //   crossedBoundary —— boundary 之后**有没有字节**。这是 waitForRender 唯一的守卫（那条
  //     调用不要求帧）。放宽成 `>=` 后，一屏全部产生于我们写入之前的旧内容会被当成「prompt
  //     已渲染」，提交在 Agent 还没回显时就宣告成功。
  //   frameObserved —— boundary 之后有没有**一个完整的同步更新帧**。放宽后，Agent 正在重画
  //     composer 的半渲染中间态会被当成「composer 已空」，readiness 落在一个下一帧就会被
  //     推翻的瞬间上。
  // -------------------------------------------------------------------------

  it('boundary 之后一个字节都没来就不算就绪——不要求帧时，字节界是唯一的守卫', async () => {
    const evidence = new AgentTerminalScreenEvidence(80, 24, { start: FRAME_START, end: FRAME_END })
    try {
      const firstFrame = `${FRAME_START}\u001b[22;1H› \u001b[22;3H${FRAME_END}`
      const boundary = encoder.encode(firstFrame).byteLength
      evidenceChunk(evidence, firstFrame)
      await settle()

      let ready = false
      const waiting = evidence.wait({
        boundaryByte: boundary,
        requireOutputAfterBoundary: true,
        // 刻意**不**要 requireFrameAfterBoundary：这正是 waitForRender 那条调用的形状。
        // 此时 frameObserved 恒真，拦得住的只剩字节界这一个条件。
        predicate: (screen) => screen.composerText('›') === '',
        timeoutMessage: 'fixture timeout',
        terminalMessage: 'fixture exit'
      }).then((throughByte) => {
        ready = true
        return throughByte
      })
      await settle()
      // 起点自检：throughByte 恰好**等于** boundary。否则这条测不到 `>` 与 `>=` 的差别。
      expect(evidence.throughByte, '起点必须卡在 boundary 上，否则严格 `>` 无人质询').toBe(boundary)
      expect(ready).toBe(false)

      evidenceChunk(evidence, '\u001b[22;3H')
      await expect(waiting).resolves.toBeGreaterThan(boundary)
    } finally {
      evidence.dispose()
    }
  })

  it('boundary 之后只有零散字节、没有完整帧时不算就绪——帧游标是唯一的守卫', async () => {
    const evidence = new AgentTerminalScreenEvidence(80, 24, { start: FRAME_START, end: FRAME_END })
    try {
      const firstFrame = `${FRAME_START}\u001b[22;1H› \u001b[22;3H${FRAME_END}`
      const boundary = encoder.encode(firstFrame).byteLength
      evidenceChunk(evidence, firstFrame)
      await settle()
      // boundary 之后确实来了字节，但它们只开了一个帧、还没闭合：Agent 正在重画。
      // 两块之间必须 settle：`accept` 把写入排到 tail 上异步执行，而 `evidenceChunk` 是同步读
      // `throughByte` 造 startByte 的。不等第一块落地就投第二块，两块都会声称 startByte=0，
      // 第二块被当成「完全落在已消费游标之前」静默跳过（实测过一次：起点自检当场红）。
      evidenceChunk(evidence, `${FRAME_START}\u001b[22;3H`)
      await settle()
      // 起点自检：字节界那一侧**已经过了**，所以这条里唯一还拦得住的是帧游标。
      expect(evidence.throughByte, '起点必须已越过 boundary，否则字节界会替帧游标挡住').toBeGreaterThan(boundary)
      expect(evidence.lastCompleteFrame).toEqual({ startByte: 0, endByte: boundary })

      let ready = false
      const waiting = evidence.wait({
        boundaryByte: boundary,
        requireOutputAfterBoundary: true,
        requireFrameAfterBoundary: true,
        predicate: (screen) => screen.composerText('›') === '',
        timeoutMessage: 'fixture timeout',
        terminalMessage: 'fixture exit'
      }).then((throughByte) => {
        ready = true
        return throughByte
      })
      await settle()
      expect(ready).toBe(false)

      // 帧闭合，起点落在 boundary 上——这才是 boundary 之后画完的一帧。
      evidenceChunk(evidence, FRAME_END)
      await expect(waiting).resolves.toBeGreaterThan(boundary)
      expect(evidence.lastCompleteFrame?.startByte).toBe(boundary)
    } finally {
      evidence.dispose()
    }
  })

  it('跨块的帧标记按字节精确定位', async () => {
    const evidence = new AgentTerminalScreenEvidence(80, 24, { start: FRAME_START, end: FRAME_END })
    try {
      const frame = `${FRAME_START}hi${FRAME_END}`
      const half = Math.floor(frame.length / 2)
      evidenceChunk(evidence, frame.slice(0, half))
      await settle()
      expect(evidence.lastCompleteFrame).toBeNull()
      evidenceChunk(evidence, frame.slice(half))
      await settle()
      expect(evidence.lastCompleteFrame).toEqual({
        startByte: 0,
        endByte: encoder.encode(frame).byteLength
      })
    } finally {
      evidence.dispose()
    }
  })
})

function screenStoredSession(): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: 'screen-agent',
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: '/tmp/screen-agent',
    run: { runId: 'screen-run' },
    retiredRuns: [],
    hookBindingId: 'binding-screen',
    hookToken: 'token-screen',
    outputCursorBytes: 0,
    createdAt: 100,
    updatedAt: 100
  }
}

function screenRun(cols: number | null = 80, rows: number | null = 24): CtxmuxAdapterRun {
  return {
    runId: 'screen-run',
    lifecycleOperationId: null,
    program: 'codex',
    args: [],
    workspacePath: '/tmp/screen-agent',
    pid: 321,
    state: { type: 'running' },
    cols,
    rows,
    latestOutputBytes: 0,
    firstAvailableByte: 0,
    acceptedInputBytes: 0
  }
}

type ScreenWaiter = {
  wait(
    session: AgentMuxStoredAgentSession,
    outputBoundaryByte: number,
    requireOutputAfterBoundary: boolean,
    predicate: (screen: AgentTerminalScreen) => boolean,
    options: { timeoutMs?: number; timeoutMessage: string; terminalMessage: string }
  ): Promise<number>
}

async function screenClient(
  replays: string[],
  sizes: ReadonlyArray<{ cols: number | null; rows: number | null }> = [],
  retainedStart = 0
): Promise<{
  client: AgentMuxClient
  waiter: ScreenWaiter
  observeCalls: () => number
  replayedBytes: () => number
  emit: (event: CtxmuxAdapterObservationEvent) => void
}> {
  const store = new AgentMuxMemoryAgentSessionStore()
  await store.compareAndSwap(null, screenStoredSession())
  const client = new AgentMuxClient({ store })
  const internals = client as unknown as {
    registry: { load(hostId: string): Promise<void> }
    kernel: Record<string, unknown>
    screenEvidence: ScreenWaiter
  }
  await internals.registry.load('local')
  let observeCalls = 0
  let replayedBytes = 0
  let listener: ((event: CtxmuxAdapterObservationEvent) => void) | null = null
  internals.kernel.observeOutput = async (
    _runId: string,
    _afterByte: number,
    accept: (event: CtxmuxAdapterObservationEvent) => void
  ) => {
    const replay = replays[Math.min(observeCalls, Math.max(0, replays.length - 1))] ?? ''
    const size = sizes[Math.min(observeCalls, Math.max(0, sizes.length - 1))] ?? { cols: 80, rows: 24 }
    observeCalls += 1
    listener = accept
    const dataBytes = Uint8Array.from(Buffer.from(replay))
    replayedBytes += dataBytes.byteLength
    return {
      run: { ...screenRun(size.cols, size.rows), firstAvailableByte: retainedStart },
      replay: replay
        ? [{
            type: 'data' as const,
            runId: 'screen-run',
            startByte: retainedStart,
            endByte: retainedStart + dataBytes.byteLength,
            data: replay,
            dataBytes
          }]
        : [],
      gap: _afterByte < retainedStart ? { requestedAfterByte: _afterByte, firstAvailableByte: retainedStart } : null,
      close: async () => {}
    }
  }
  return {
    client,
    waiter: internals.screenEvidence,
    observeCalls: () => observeCalls,
    replayedBytes: () => replayedBytes,
    emit: (event) => listener?.(event)
  }
}

describe('有界增量屏幕证据接到 client 观察路径', () => {
  it('同一 Session 连续两次观察只从 byte 0 重放一次，重放字节量相对全量基线有界', async () => {
    // 大体积历史：全量基线下第二次观察会把它整个再重放一遍（2x）。
    const history = `${'x'.repeat(64 * 1024)}\r\n${FRAME_START}\u001b[2J\u001b[22;1H› hello${FRAME_END}`
    const historyBytes = Buffer.byteLength(history)
    const { client, waiter, observeCalls, replayedBytes } = await screenClient([history])
    const session = screenStoredSession()

    const first = await waiter.wait(
      session,
      0,
      true,
      (screen) => screen.composerText('›') === 'hello',
      { timeoutMs: 1_000, timeoutMessage: 'fixture timeout', terminalMessage: 'fixture exit' }
    )
    expect(first).toBe(historyBytes)

    const second = await waiter.wait(
      session,
      0,
      true,
      (screen) => screen.composerText('›') === 'hello',
      { timeoutMs: 1_000, timeoutMessage: 'fixture timeout', terminalMessage: 'fixture exit' }
    )
    expect(second).toBe(historyBytes)

    // 有界性的两把尺：不再有第二次 byte-0 观察；重放总量 = 历史一份（全量基线是 2 份）。
    expect(observeCalls()).toBe(1)
    expect(replayedBytes()).toBe(historyBytes)
    expect(replayedBytes()).toBeLessThan(2 * historyBytes)
    await client.dispose()
  })

  it('gap 失效后丢弃重建，重建仍能正确判定 composer', async () => {
    const first = `${FRAME_START}\u001b[22;1H› one\u001b[22;7H${FRAME_END}`
    const second = `${FRAME_START}\u001b[22;1H› two\u001b[22;7H${FRAME_END}`
    const { client, waiter, observeCalls, emit } = await screenClient([first, second])
    const session = screenStoredSession()

    await expect(waiter.wait(
      session,
      0,
      true,
      (screen) => screen.composerText('›') === 'one',
      { timeoutMs: 1_000, timeoutMessage: 'fixture timeout', terminalMessage: 'fixture exit' }
    )).resolves.toBeGreaterThan(0)

    // CtxMux 驱逐了旧输出：长命证据必须失效，不许拿旧屏幕继续作证。
    emit({ type: 'gap', runId: 'screen-run', latestOutputBytes: 8192 })

    await expect(waiter.wait(
      session,
      0,
      true,
      (screen) => screen.composerText('›') === 'two',
      { timeoutMs: 1_000, timeoutMessage: 'fixture timeout', terminalMessage: 'fixture exit' }
    )).resolves.toBeGreaterThan(0)
    expect(observeCalls()).toBe(2)
    await client.dispose()
  })

  it('Resized 后按新的 owner-confirmed 尺寸重建，不再用启动宽度解析后续输出', async () => {
    const narrow = `${FRAME_START}\u001b[22;1H› one\u001b[22;7H${FRAME_END}`
    const wide = `${FRAME_START}\u001b[2J\u001b[22;1H› head\u001b[22;150Htail${FRAME_END}`
    const { client, waiter, observeCalls, emit } = await screenClient(
      [narrow, wide],
      [
        { cols: 80, rows: 24 },
        { cols: 200, rows: 87 }
      ]
    )
    const session = screenStoredSession()

    await expect(waiter.wait(
      session,
      0,
      true,
      (screen) => screen.composerText('›') === 'one',
      { timeoutMs: 1_000, timeoutMessage: 'fixture timeout', terminalMessage: 'fixture exit' }
    )).resolves.toBeGreaterThan(0)

    emit({ type: 'resized', runId: 'screen-run', cols: 200, rows: 87 })

    await expect(waiter.wait(
      session,
      0,
      true,
      (screen) => screen.composerText('›') === `head${' '.repeat(143)}tail`,
      { timeoutMs: 1_000, timeoutMessage: 'fixture timeout', terminalMessage: 'fixture exit' }
    )).resolves.toBeGreaterThan(0)
    expect(observeCalls()).toBe(2)
    await client.dispose()
  })

  it('current_size 未知时 fail-closed，不用 spec.size 造屏', async () => {
    const { client, waiter } = await screenClient(
      [`${FRAME_START}\u001b[22;1H› one${FRAME_END}`],
      [{ cols: null, rows: null }]
    )
    await expect(waiter.wait(
      screenStoredSession(),
      0,
      true,
      (screen) => screen.composerText('›') === 'one',
      { timeoutMs: 1_000, timeoutMessage: 'fixture timeout', terminalMessage: 'fixture exit' }
    )).rejects.toMatchObject({ code: 'TERMINAL_SIZE_UNKNOWN' })
    await client.dispose()
  })
})


it('retains the attachment after prefix eviction and recovers only after a real terminal reset', async () => {
  const prefix = `${FRAME_START}\u001b[2J\u001b[22;1H› hello${FRAME_END}`
  const { client, waiter, emit, observeCalls } = await screenClient([prefix], [], 100)
  const options = { timeoutMs: 100, timeoutMessage: 'timeout', terminalMessage: 'exit' }
  const observe = () => waiter.wait(screenStoredSession(), 100, true,
    (screen) => screen.composerText('›') === 'hello', options)
  try {
    // Clear + positioning + complete synchronization frame still lacks prior terminal modes.
    await expect(observe()).rejects.toMatchObject({ code: 'OUTPUT_GAP' })
    let cursor = 100 + Buffer.byteLength(prefix)
    const send = (text: string) => {
      const dataBytes = Uint8Array.from(Buffer.from(text))
      emit({ type: 'data', runId: 'screen-run', startByte: cursor, endByte: cursor + dataBytes.length, data: text, dataBytes })
      cursor += dataBytes.length
    }
    send('\u001b')
    await expect(observe()).rejects.toMatchObject({ code: 'OUTPUT_GAP' })
    send(`c${FRAME_START}\u001b[22;1H› hello${FRAME_END}`)
    await expect(observe()).resolves.toBe(cursor)
    expect(observeCalls()).toBe(1)
    // Real gaps after recovery remain invalidating, never silently bridged.
    emit({ type: 'gap', runId: 'screen-run', latestOutputBytes: cursor + 99 })
    await expect(observe()).rejects.toMatchObject({ code: 'OUTPUT_GAP' })
    expect(observeCalls()).toBe(2)
  } finally { await client.dispose() }
})
