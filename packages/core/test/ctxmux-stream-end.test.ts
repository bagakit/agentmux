import { describe, expect, it } from 'vitest'
import { classifyStreamEnd } from '../src/ctxmux-stream-end.js'

// 这条分类是掉线检测的判据核心：pump 收尾时唯一决定「要不要驱动重连去问 daemon 真相」的地方。
// 三种结局的语义天差地别，任何一条被折叠都会造成真实故障——要么重连风暴（正常退出被判丢线），
// 要么死代码复活（丢线被判正常，run 永远卡最后状态，正是本任务要消灭的历史缺陷）。
describe('classifyStreamEnd', () => {
  it('treats a clean end that never emitted a terminal event as connection-lost (the historical defect)', () => {
    // daemon 优雅关流却没交代 run 下场：旧 pump 在这一支只删 attachment、什么都不发，run 永远停在
    // 最后状态。它必须被判 connection-lost，否则整套 disconnected UX 又变回死代码。
    expect(classifyStreamEnd({ threw: false, sawTerminalEvent: false, stillOwned: true }))
      .toBe('connection-lost')
  })

  it('treats a thrown end (wire failure) as connection-lost', () => {
    expect(classifyStreamEnd({ threw: true, sawTerminalEvent: false, stillOwned: true }))
      .toBe('connection-lost')
    // 抛错时即便之前发过终结事件，也仍是 wire 断了——单 daemon 语义下判连接丢失。
    expect(classifyStreamEnd({ threw: true, sawTerminalEvent: true, stillOwned: true }))
      .toBe('connection-lost')
  })

  it('treats a clean end that emitted a terminal event as run-exited (no action)', () => {
    // 关键不变量：正常退出（发过 exited/interrupted 后 events() 干净 return）绝不能判 connection-lost，
    // 否则每一次正常退出都会触发一次重连风暴。这一路必须与「没发过终结事件」分开。
    expect(classifyStreamEnd({ threw: false, sawTerminalEvent: true, stillOwned: true }))
      .toBe('run-exited')
  })

  it('treats a not-owned end as detached regardless of how it ended', () => {
    // 我们自己换/删了 attachment：这次收尾是主动的，什么都不该做——即使它同时抛了错或没发终结事件。
    // detached 分支若塌进 connection-lost，正常的 detach/replace 会误触发重连。
    for (const threw of [false, true]) {
      for (const sawTerminalEvent of [false, true]) {
        expect(classifyStreamEnd({ threw, sawTerminalEvent, stillOwned: false }))
          .toBe('detached')
      }
    }
  })
})
