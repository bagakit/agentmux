import { describe, expect, it, vi } from 'vitest'
import { OrderedSessionOutputFollow, type FollowOutput } from '../src/session-output-follow.js'
import type { AgentMuxClientEvent, AgentMuxRunDataEvent } from '../src/types.js'

function output(startByte: number, data: string): Extract<AgentMuxClientEvent, { type: 'terminal-output' }> {
  const endByte = startByte + Buffer.byteLength(data)
  return {
    type: 'terminal-output',
    run: { runId: 'run' },
    data,
    evidence: {
      source: 'terminal-output',
      observedAt: 1,
      run: { runId: 'run' },
      outputByteRange: { startByte, endByte }
    }
  }
}

function replay(startByte: number, data: string): AgentMuxRunDataEvent {
  return {
    type: 'data',
    runId: 'run',
    startByte,
    endByte: startByte + Buffer.byteLength(data),
    data
  }
}

describe('ordered Session output follow', () => {
  it('emits replay before buffered live output and removes ranges already covered by replay', () => {
    const seen: unknown[] = []
    const stream = new OrderedSessionOutputFollow(
      'run',
      0,
      (event) => seen.push(event),
      (event) => seen.push(event)
    )
    stream.accept(output(0, 'abc'))
    stream.accept(output(3, 'def'))

    stream.finishReplay([replay(0, 'abc')])

    expect(seen).toEqual([
      { runId: 'run', replay: true, startByte: 0, endByte: 3, data: 'abc' },
      { runId: 'run', replay: false, startByte: 3, endByte: 6, data: 'def' }
    ])
  })

  it('trims a partially overlapping live range and then stays monotonic', () => {
    const seen: unknown[] = []
    const stream = new OrderedSessionOutputFollow('run', 0, (event) => seen.push(event), vi.fn())
    stream.accept(output(3, 'def'))
    stream.finishReplay([replay(0, 'abcd')])
    stream.accept(output(6, 'ghi'))

    expect(seen).toEqual([
      { runId: 'run', replay: true, startByte: 0, endByte: 4, data: 'abcd' },
      { runId: 'run', replay: false, startByte: 4, endByte: 6, data: 'ef' },
      { runId: 'run', replay: false, startByte: 6, endByte: 9, data: 'ghi' }
    ])
  })

  // 上面两条的操作数全是 ASCII（abcd/ef/ghi），于是「按字节裁」与「按字符裁」在它们身上完全同形：
  // 把 dataAfterByte 的 `Buffer.from(data).subarray(...)` 换成 `data.slice(...)`，三条全绿。而 startByte/
  // endByte 是 daemon 给的 **UTF-8 字节**偏移，重叠边界不会对齐字符边界——CJK 输出上按字符裁就错位。
  // desktop 侧那条同名裁剪（lib/terminal-live-output.ts 的 dataAfterByte）已有 CJK 用例守着，且它的注释
  // 亲口写着「两边不许只有一边对」；这一条把 core 这半边补上（记忆 property-unobservable-in-default-env：
  // 判别器在默认操作数下不可观测时，要由测试自己把它带进场）。
  it('trims the overlap by bytes, not characters — a CJK boundary desyncs a char slice', () => {
    const seen: FollowOutput[] = []
    const stream = new OrderedSessionOutputFollow('run', 0, (event) => seen.push(event), vi.fn())
    // '中' 与 '文' 各占 3 字节：live 事件覆盖 0..6，replay 已覆盖 0..3，于是要裁掉的正是头一个字符。
    stream.accept(output(0, '中文'))
    stream.finishReplay([replay(0, '中')])

    expect(seen).toEqual([
      { runId: 'run', replay: true, startByte: 0, endByte: 3, data: '中' },
      // 按字节裁得到 '文'；按字符裁是 '中文'.slice(3) === ''（整个字符静默消失）。
      { runId: 'run', replay: false, startByte: 3, endByte: 6, data: '文' }
    ])
  })

  it('keeps every emitted range consistent with its own payload byte length', () => {
    const seen: FollowOutput[] = []
    const stream = new OrderedSessionOutputFollow('run', 0, (event) => seen.push(event), vi.fn())
    stream.accept(output(0, '中文abc'))
    stream.finishReplay([replay(0, '中')])

    // 上一条钉的是那一个具体取值；这一条钉的是**不变量**，所以任何新的裁剪写法都要过它：
    // 报出去的 [startByte, endByte) 必须与 data 的字节长度自洽。期望值取自 range 字段（变异改的是 data，
    // 不是 range），所以它不会跟着变异一起漂（记忆 expected-value-must-not-derive-from-mutation-target）。
    const ranged = seen.filter((event) => event.startByte !== null && event.endByte !== null)
    // 在场自证：至少要有一条被裁过的实时事件，否则这个 filter 可能是空集而断言恒真。
    expect(ranged.some((event) => !event.replay), '没有任何带字节范围的实时事件——判据在空集上恒真').toBe(true)
    for (const event of ranged) {
      expect(
        Buffer.byteLength(event.data),
        `事件 [${event.startByte!}, ${event.endByte!}) 报的范围与 data 的字节长度不符：${JSON.stringify(event.data)}`
      ).toBe(event.endByte! - event.startByte!)
    }
  })

  it('holds a process end behind replay just like live bytes', () => {
    const order: string[] = []
    const stream = new OrderedSessionOutputFollow(
      'run',
      0,
      () => order.push('output'),
      () => order.push('end')
    )
    stream.accept({
      type: 'process-state',
      run: { runId: 'run' },
      state: 'exited',
      pid: 1,
      exitCode: 0,
      evidence: {
        source: 'run-process',
        observedAt: 1,
        run: { runId: 'run' }
      }
    })
    expect(order).toEqual([])

    stream.finishReplay([replay(0, 'done')])
    expect(order).toEqual(['output', 'end'])
  })
})
