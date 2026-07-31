import { describe, expect, it } from 'vitest'
import { classifyRunExit } from '../src/agent-run-exit.js'

// 意图 vs 结果是两个独立事实。这些用例证明分类既不把意图当结果，也不把裸 0 当「干净完成」。
describe('run exit reason classification', () => {
  it('reads a recorded stop intent as user-stopped, whatever the code or signal', () => {
    // 有意图 → user-stopped，结果里的码/信号只是停止的副作用，不改「为什么」。
    expect(classifyRunExit({ stopRequested: true })).toBe('user-stopped')
    expect(classifyRunExit({ stopRequested: true, exitCode: 0 })).toBe('user-stopped')
    expect(classifyRunExit({ stopRequested: true, exitCode: 137 })).toBe('user-stopped')
    expect(classifyRunExit({ stopRequested: true, exitSignal: 'SIGKILL' })).toBe('user-stopped')
  })

  it('reads a failure signal or non-zero code without intent as crashed', () => {
    expect(classifyRunExit({ stopRequested: false, exitSignal: 'SIGSEGV' })).toBe('crashed')
    expect(classifyRunExit({ stopRequested: false, exitCode: 1 })).toBe('crashed')
    expect(classifyRunExit({ stopRequested: false, exitCode: 255 })).toBe('crashed')
  })

  it('never treats a bare 0 without stop intent as clean completion — it is unknown', () => {
    // 这条是验收「读不出结论时如实归为未知，不把裸 0 当成干净结束的证据」的守门断言。
    expect(classifyRunExit({ stopRequested: false, exitCode: 0 })).toBe('unknown')
    expect(classifyRunExit({ stopRequested: false })).toBe('unknown')
  })
})
