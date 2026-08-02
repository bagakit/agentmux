import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The store action `createPullRequest` executed for real — both exits of its intent gate.
 *
 * `pr-launch.test.tsx:680` guards the CALLER: it pins that the panel hands the plan's own
 * `token`/`current`/`eligibility` into the action. But nothing drove the action's own body, so the
 * `if (verdict.kind === 'conflict')` gate at `store.ts` had no witness — inverting it to `=== 'proceed'`
 * left the whole desktop suite green while shipping the exact disaster the code comments describe: a
 * payload whose captured token no longer matches the current branch/base is no longer aborted, and a
 * pull request opens against a base the user never saw.
 *
 * Design: guard the number of EXITS, not conditions. Both sides get a witness here —
 *   1. a genuine `conflict` verdict must REFUSE and must never touch the gh bridge, and
 *   2. a genuine `proceed` verdict must actually REACH the bridge.
 * A test that only pins the refusal lets the accept side rot, and vice versa.
 *
 * The token/current pairs are classified by the REAL `evaluateCreatePrIntent` (never stubbed — a stub
 * would prove nothing about the wiring), and each test asserts the classifier's verdict FIRST, so the
 * fixture's shape is proven to be what the store will actually see rather than merely plausible.
 */

// One spy shared by the stubbed gh bridge across tests; cleared per test. The store's proceed path
// reaches it through `ghBridge()` → `window.agentmux.gh`, the same converged lookup production uses.
const ghCreatePullRequest = vi.hoisted(() =>
  vi.fn(async () => ({ kind: 'created' as const, url: 'https://example.test/pr/1' }))
)

// The store imports `api`, which reads `__AGENTMUX_WEB_PREVIEW__` at module load. Establish it before
// the static import below so the module graph resolves — this action never touches `api`, only the gh
// bridge, so the mock branch is irrelevant to what is under test.
vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { AppConfig, WorkspaceRecord } from '../src/shared/contracts.js'
import { CONFIG_VERSION } from '../src/shared/contracts.js'
import {
  evaluateCreatePrIntent,
  type CreatePrIntentState,
  type CreatePrToken
} from '../src/renderer/src/lib/create-pr-intent.js'
import { useAppStore } from '../src/renderer/src/store.js'

const initialState = useAppStore.getState()

const WORKSPACE: WorkspaceRecord = {
  id: 'ws-pr',
  name: 'repo',
  hostId: 'local',
  path: '/repo/.worktrees/feature',
  kind: 'folder'
}
const CONFIG: AppConfig = {
  // 从 SSOT 取，不手抄数字：desktop 的 tsconfig include 只有 src/**，test/ 不过 tsc，
  // 所以写死的旧版本号（本文件原先是 7，而 CONFIG_VERSION 已是 9）不会被编译器抓到。
  version: CONFIG_VERSION,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [WORKSPACE],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
}

// The click's captured intent: what the user was aiming at when they pressed the button.
const token: CreatePrToken = {
  worktreeId: 'wt-feature',
  worktreePath: '/repo/.worktrees/feature',
  branch: 'feature',
  baseRef: 'origin/main',
  startedAt: 1
}

// The state NOW, with the branch drifted underneath the same worktree — the exact "payload no longer
// describes what the user asked for" case the abort exists for.
const driftedCurrent: CreatePrIntentState = {
  worktreeId: 'wt-feature',
  branch: 'feature-renamed',
  baseRef: 'origin/main'
}

// The state NOW, unchanged: nothing moved, so the run should land.
const steadyCurrent: CreatePrIntentState = {
  worktreeId: 'wt-feature',
  branch: 'feature',
  baseRef: 'origin/main'
}

beforeEach(() => {
  // `ghBridge()` reads `window.agentmux?.gh` at call time — the same bridge the panel uses. Provide a
  // gh whose createPullRequest is a spy so "did the proceed path reach it?" is directly observable.
  ;(globalThis as unknown as { window?: unknown }).window = {
    agentmux: { gh: { prReadiness: vi.fn(), createPullRequest: ghCreatePullRequest } }
  }
  useAppStore.setState({ config: CONFIG, activeWorkspaceId: WORKSPACE.id, error: null })
})

afterEach(() => {
  useAppStore.setState(initialState, true)
  ghCreatePullRequest.mockClear()
})

describe('store.createPullRequest — both exits of the intent gate are driven', () => {
  it('a genuine conflict verdict REFUSES and never reaches the gh bridge', async () => {
    // Fixture-shape proof: the REAL classifier must call this pair a conflict, or the rest of the test
    // is asserting against a case the store will never take. (id-vs-agentSessionId class of bug.)
    const verdict = evaluateCreatePrIntent(token, driftedCurrent)
    expect(verdict.kind, 'fixture does not actually classify as a conflict').toBe('conflict')
    if (verdict.kind !== 'conflict') return

    const result = await useAppStore.getState().createPullRequest({
      workspaceId: WORKSPACE.id,
      title: 'Add retry',
      body: 'body',
      token,
      current: driftedCurrent
    })

    // Exit 1: the honest refusal, carrying the classifier's own reason (not a fabricated one).
    expect(result).toEqual({ kind: 'refused', reason: verdict.reason })
    // The refusal is surfaced to the user, not swallowed.
    expect(useAppStore.getState().error).toBe(verdict.reason)
    // The load-bearing assertion: a drifted payload must NEVER open a PR. If the gate is inverted the
    // store falls through to here and opens one against a base the user never saw.
    expect(
      ghCreatePullRequest,
      'a drifted (conflict) payload reached gh — it just opened a PR against a target nobody chose'
    ).not.toHaveBeenCalled()
  })

  it('a genuine proceed verdict REACHES the gh bridge with the token’s base', async () => {
    // Fixture-shape proof for the accept side: the real classifier must call this pair `proceed`.
    const verdict = evaluateCreatePrIntent(token, steadyCurrent)
    expect(verdict.kind, 'fixture does not actually classify as proceed').toBe('proceed')

    const result = await useAppStore.getState().createPullRequest({
      workspaceId: WORKSPACE.id,
      title: 'Add retry',
      body: 'body',
      token,
      current: steadyCurrent
    })

    // Exit 2: proceed actually lands. Without this assertion the accept side has no witness, and a
    // mutation that stops the proceed path from ever calling the bridge would ship silently.
    expect(
      ghCreatePullRequest,
      'a clean (proceed) payload never reached gh — the create call is dead'
    ).toHaveBeenCalledTimes(1)
    // It targets the base captured in the token — the one the guard just cleared — not some re-derived
    // value. (`--base` is `token.baseRef`.)
    expect(ghCreatePullRequest.mock.calls[0]).toEqual([
      WORKSPACE.id,
      { title: 'Add retry', body: 'body', base: token.baseRef }
    ])
    expect(result).toEqual({ kind: 'created', url: 'https://example.test/pr/1' })
  })
})
