import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// The fan-out vertical slice has to be REACHABLE, not merely well-tested.
//
// planFanOut / runFanOut / keepOneOfFanOut / removeWorktree were all implemented
// and covered by 37 unit assertions, yet none of them had a single production
// caller: there was no fan-out entry in contracts, preload, ipc or the store, so
// a user could not start a fan-out or resolve one. The comparison strip could
// display lanes that nothing was able to create.
//
// These assertions pin every hop of the chain. They go red the moment a layer is
// dropped, which is exactly how the gap went unnoticed the first time: unit tests
// stay green when the wiring does not exist at all.
//
// 但它们只证明"这一层存在"，证明不了"这一层跑得到"——实测：在 ipc.ts 的 runFanOut handler
// 第一行插 `return { kind: 'rejected', reason: ... }`，整段编排变死代码、扇出对用户永久失效，
// 而这里 5 条全绿（死代码里那些标识符照旧存在）。编排因此搬进了 fanout-request，由
// fanout-request.test.ts 真跑；这个文件只剩"每一跳都在"这一件事。
// ---------------------------------------------------------------------------

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

describe('fan-out is wired end to end', () => {
  it('declares the fan-out contract on the workspaces API', () => {
    const contracts = read('../src/shared/contracts.ts')
    // The result shape is the one runFanOut already returns — no second vocabulary.
    expect(contracts).toContain('FanOutLaneOutcome')
    expect(contracts).toContain('runFanOut(')
    expect(contracts).toContain('keepOneOfFanOut(')
  })

  it('exposes both verbs through preload', () => {
    const preload = read('../src/preload/index.ts')
    expect(preload).toContain("'workspaces:runFanOut'")
    expect(preload).toContain("'workspaces:keepOneOfFanOut'")
  })

  it('handles them in main, planning through the single naming source', () => {
    const ipc = read('../src/main/ipc.ts')
    expect(ipc).toContain("handle('workspaces:runFanOut'")
    expect(ipc).toContain("handle('workspaces:keepOneOfFanOut'")
    expect(ipc).toContain('keepOneOfFanOut(')
    // 扇出的编排**不在** ipc.ts：它在 fanout-request 里，因为 handler 长在 registerIpc 的闭包里，
    // 本仓没有任何测试 import 得到它——于是在 handler 第一行插一句 `return { kind: 'rejected' }`，
    // 扇出对用户永久失效而这里 5 条全绿（实测）。handler 现在只转发。
    expect(ipc).toContain('runFanOutRequest(')
    // 命名与编排都不许回到这里。判据是 **import 关系**而不是调用点的字面形状：把 planFanOut
    // 作为裸标识符提回 ipc.ts（不带括号）就能绕过 `not.toContain('planFanOut(')`——实测那颗
    // 变异 16 条全绿。能被 import 就能被调用。
    expect(
      ipc,
      'ipc.ts 又 import 了 fanout-plan——那意味着一段没人跑得到的编排落回了闭包里'
    ).not.toContain('./fanout-plan.js')
  })

  it('offers a store action for each verb so a surface can call them', () => {
    const store = read('../src/renderer/src/store.ts')
    expect(store).toContain('runFanOut(')
    expect(store).toContain('keepOneOfFanOut(')
  })

  // The two user gestures. Without these the slice is reachable only from a test: nobody can start a
  // bake-off, and nobody can resolve one.
  it('gives the user a way to start a fan-out and a way to keep one lane', () => {
    const branches = read('../src/renderer/src/components/BranchesPanel.tsx')
    // Starting: the panel builds a request through the pure model, then calls the store action.
    expect(branches).toContain('buildFanOutRequest(')
    expect(branches).toContain('runFanOut(')

    const strip = read('../src/renderer/src/components/FanOutStrip.tsx')
    const board = read('../src/renderer/src/components/WorkspaceBoard.tsx')
    // Resolving: the comparison strip offers a keep control, wired to the store from the board.
    expect(strip).toContain('fanOutKeepSplit(')
    expect(board).toContain('keepOneOfFanOut(')
  })
})
