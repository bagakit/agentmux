import { describe, expect, it, vi } from 'vitest'
import { OrderedSessionOutputFollow, type FollowOutput } from '../src/session-output-follow.js'
import type { AgentMuxClientEvent, AgentMuxRunDataEvent } from '../src/types.js'

function bytes(data: string): Uint8Array { return Uint8Array.from(Buffer.from(data)) }

function output(startByte: number, data: string): Extract<AgentMuxClientEvent, { type: 'terminal-output' }> {
  const endByte = startByte + Buffer.byteLength(data)
  return {
    type: 'terminal-output',
    run: { runId: 'run' },
    data,
    dataBytes: bytes(data),
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
    data,
    dataBytes: bytes(data)
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
      { runId: 'run', replay: true, startByte: 0, endByte: 3, dataBytes: bytes('abc') },
      { runId: 'run', replay: false, startByte: 3, endByte: 6, dataBytes: bytes('def') }
    ])
  })

  it('trims a partially overlapping live range and then stays monotonic', () => {
    const seen: unknown[] = []
    const stream = new OrderedSessionOutputFollow('run', 0, (event) => seen.push(event), vi.fn())
    stream.accept(output(3, 'def'))
    stream.finishReplay([replay(0, 'abcd')])
    stream.accept(output(6, 'ghi'))

    expect(seen).toEqual([
      { runId: 'run', replay: true, startByte: 0, endByte: 4, dataBytes: bytes('abcd') },
      { runId: 'run', replay: false, startByte: 4, endByte: 6, dataBytes: bytes('ef') },
      { runId: 'run', replay: false, startByte: 6, endByte: 9, dataBytes: bytes('ghi') }
    ])
  })

  // The payload is raw Run bytes. Overlap can end inside a UTF-8 sequence; text slicing or
  // re-encoding the semantic observation cannot reproduce that byte range.
  it('trims the overlap by bytes, not characters — a CJK boundary desyncs a char slice', () => {
    const seen: FollowOutput[] = []
    const stream = new OrderedSessionOutputFollow('run', 0, (event) => seen.push(event), vi.fn())
    // '中' 与 '文' 各占 3 字节：live 事件覆盖 0..6，replay 已覆盖 0..3，于是要裁掉的正是头一个字符。
    stream.accept(output(0, '中文'))
    stream.finishReplay([replay(0, '中')])

    expect(seen).toEqual([
      { runId: 'run', replay: true, startByte: 0, endByte: 3, dataBytes: bytes('中') },
      // 按字节裁得到 '文'；按字符裁是 '中文'.slice(3) === ''（整个字符静默消失）。
      { runId: 'run', replay: false, startByte: 3, endByte: 6, dataBytes: bytes('文') }
    ])
  })

  it('keeps every emitted range consistent with its own payload byte length', () => {
    const seen: FollowOutput[] = []
    const stream = new OrderedSessionOutputFollow('run', 0, (event) => seen.push(event), vi.fn())
    stream.accept(output(0, '中文abc'))
    stream.finishReplay([replay(0, '中')])

    // Exact byte ranges and raw payload lengths describe the same owner fact.
    const ranged = seen
    // 在场自证：至少要有一条被裁过的实时事件，否则这个 filter 可能是空集而断言恒真。
    expect(ranged.some((event) => !event.replay), '没有任何带字节范围的实时事件——判据在空集上恒真').toBe(true)
    for (const event of ranged) {
      expect(
        event.dataBytes.byteLength,
        `事件 [${event.startByte!}, ${event.endByte!}) 报的范围与 data 的字节长度不符：${JSON.stringify([...event.dataBytes])}`
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
