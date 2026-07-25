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
    // The handler must not mint branch names or paths itself — planFanOut is the one source,
    // which is the entire reason that module exists.
    expect(ipc).toContain('planFanOut(')
    expect(ipc).toContain('runFanOut(')
    expect(ipc).toContain('keepOneOfFanOut(')
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
