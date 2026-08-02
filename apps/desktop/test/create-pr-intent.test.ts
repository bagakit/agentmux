import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  evaluateCreatePrIntent,
  intentAllowsCreate,
  normalizeBaseRef,
  type CreatePrToken
} from '../src/renderer/src/lib/create-pr-intent.js'

const token: CreatePrToken = {
  worktreeId: 'wt-feature',
  worktreePath: '/repo/.worktrees/feature',
  branch: 'feature',
  baseRef: 'origin/main',
  startedAt: 1
}

describe('normalizeBaseRef', () => {
  it('treats the fully-qualified and short forms of one ref as the same target', () => {
    expect(normalizeBaseRef('refs/remotes/origin/main')).toBe(normalizeBaseRef('origin/main'))
    expect(normalizeBaseRef('refs/heads/main')).toBe('main')
  })

  it('never collapses a different remote into the same target', () => {
    // upstream/main is another repository entirely; opening a PR against it would target something
    // the user never picked.
    expect(normalizeBaseRef('upstream/main')).not.toBe(normalizeBaseRef('origin/main'))
  })
})

describe('evaluateCreatePrIntent', () => {
  it('proceeds when nothing moved', () => {
    const verdict = evaluateCreatePrIntent(token, {
      worktreeId: 'wt-feature',
      branch: 'feature',
      baseRef: 'origin/main'
    })
    expect(verdict.kind).toBe('proceed')
    expect(intentAllowsCreate(verdict)).toBe(true)
  })

  // The core boundary, and the one that is easy to implement backwards.
  it('does NOT treat switching to another worktree as a conflict', () => {
    const verdict = evaluateCreatePrIntent(token, {
      worktreeId: 'wt-somewhere-else',
      // Deliberately different branch and base too: they belong to the other worktree and say nothing
      // about the one this run was aimed at.
      branch: 'unrelated',
      baseRef: 'origin/release'
    })
    expect(verdict.kind).toBe('proceed-detached')
    // The run still lands — otherwise opening a second window mid-flight would silently discard the PR.
    expect(intentAllowsCreate(verdict)).toBe(true)
  })

  it('conflicts when the branch drifts inside the SAME worktree', () => {
    const verdict = evaluateCreatePrIntent(token, {
      worktreeId: 'wt-feature',
      branch: 'feature-renamed',
      baseRef: 'origin/main'
    })
    expect(verdict.kind).toBe('conflict')
    expect(intentAllowsCreate(verdict)).toBe(false)
    if (verdict.kind !== 'conflict') return
    // The message names both ends so the user can tell what happened.
    expect(verdict.reason).toContain('feature')
    expect(verdict.reason).toContain('feature-renamed')
  })

  it('conflicts when the base drifts inside the same worktree', () => {
    const verdict = evaluateCreatePrIntent(token, {
      worktreeId: 'wt-feature',
      branch: 'feature',
      baseRef: 'origin/release'
    })
    expect(verdict.kind).toBe('conflict')
    expect(intentAllowsCreate(verdict)).toBe(false)
  })

  it('does not conflict when the base is merely spelled differently', () => {
    // Same target, fully-qualified. Aborting here would be a false alarm.
    const verdict = evaluateCreatePrIntent(token, {
      worktreeId: 'wt-feature',
      branch: 'feature',
      baseRef: 'refs/remotes/origin/main'
    })
    expect(verdict.kind).toBe('proceed')
  })

  it('conflicts when the base moves to another remote that merely looks similar', () => {
    const verdict = evaluateCreatePrIntent(token, {
      worktreeId: 'wt-feature',
      branch: 'feature',
      baseRef: 'upstream/main'
    })
    expect(verdict.kind).toBe('conflict')
  })
})

// The pieces T-004 and T-005 built are only worth having if the create flow actually consults them.
// Each of these went red before the store action was wired, and goes red again if a hop is removed.
describe('create-PR flow consumes the pieces it was built on', () => {
  const store = readFileSync(
    new URL('../src/renderer/src/store.ts', import.meta.url),
    'utf8'
  )

  it('checks the run-token before creating', () => {
    expect(store).toContain('evaluateCreatePrIntent(')
  })

  it('runs the eligibility ladder and renders its blocker copy', () => {
    // Without this the user gets whatever gh says on failure instead of "push it first".
    expect(store).toContain('evaluatePrEligibility(')
    expect(store).toContain('PR_BLOCKER_MESSAGES[')
  })

  it('reaches gh through the converged preload lookup, not the shared web-preview mock', () => {
    // The mock has no gh; routing through it would fabricate a pull request that never happened.
    //
    // 判据从 `window.agentmux?.gh` 改成 `ghBridge()`：#364 把「桥在不在」这一个判断收敛进了
    // `lib/git-bridge`，所以这里手抄那个取值形状**已经是被禁止的写法**。桥缺席时的说法也归那一层。
    // 「除了那一层没人再摸 window」由 `git-bridge-convergence.test.ts` 整体钉住；这一条只钉这条
    // 具体路径确实走了它，而不是绕过去自己判一次。
    expect(store).toContain('ghBridge()')
  })
})
