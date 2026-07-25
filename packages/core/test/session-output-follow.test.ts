import { describe, expect, it, vi } from 'vitest'
import { OrderedSessionOutputFollow } from '../src/session-output-follow.js'
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
