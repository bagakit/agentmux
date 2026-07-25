import { describe, expect, it } from 'vitest'
import {
  evaluatePrEligibility,
  PR_BLOCKER_MESSAGES,
  type PrEligibilityInput
} from '../src/renderer/src/lib/pr-eligibility'

// A fully-ready input: authenticated, gh present, a feature branch ahead of a base that exists on the
// remote, an upstream configured, and no uncommitted work. Each test knocks out exactly one condition
// so the ladder's mapping from an unmet condition to a blocker key is isolated.
const ready: PrEligibilityInput = {
  auth: { kind: 'authenticated' },
  branch: 'feature',
  baseRef: 'main',
  baseExistsOnRemote: true,
  upstream: 'refs/remotes/origin/feature',
  ahead: 3,
  behind: 0,
  hasUncommittedChanges: false
}

describe('evaluatePrEligibility (pure ladder)', () => {
  it('clears every gate when the branch is ready to open a PR', () => {
    const result = evaluatePrEligibility(ready)
    expect(result.eligible).toBe(true)
    expect(result.blockers).toEqual([])
  })

  it('blocks on a missing gh binary with the install-gh key', () => {
    const result = evaluatePrEligibility({ ...ready, auth: { kind: 'not-installed' } })
    expect(result.eligible).toBe(false)
    expect(result.blockers).toContain('gh-not-installed')
  })

  it('blocks on an unauthenticated gh with the auth-login key — distinct from a missing binary', () => {
    const result = evaluatePrEligibility({ ...ready, auth: { kind: 'not-authenticated' } })
    expect(result.eligible).toBe(false)
    expect(result.blockers).toContain('gh-not-authenticated')
    expect(result.blockers).not.toContain('gh-not-installed')
  })

  it('blocks when the branch has no upstream', () => {
    const result = evaluatePrEligibility({ ...ready, upstream: null })
    expect(result.eligible).toBe(false)
    expect(result.blockers).toContain('no-upstream')
  })

  it('blocks when the branch is not ahead of its upstream — nothing to open a PR with', () => {
    const result = evaluatePrEligibility({ ...ready, ahead: 0 })
    expect(result.eligible).toBe(false)
    expect(result.blockers).toContain('not-ahead')
  })

  it('blocks when the branch is behind its upstream — sync before opening a PR', () => {
    const result = evaluatePrEligibility({ ...ready, behind: 2 })
    expect(result.eligible).toBe(false)
    expect(result.blockers).toContain('behind-upstream')
  })

  it('blocks when the branch equals the base — a PR needs two distinct refs', () => {
    const result = evaluatePrEligibility({ ...ready, branch: 'main', baseRef: 'main' })
    expect(result.eligible).toBe(false)
    expect(result.blockers).toContain('branch-equals-base')
  })

  it('blocks when there are uncommitted changes', () => {
    const result = evaluatePrEligibility({ ...ready, hasUncommittedChanges: true })
    expect(result.eligible).toBe(false)
    expect(result.blockers).toContain('uncommitted-changes')
  })

  it('blocks when the base does not exist on the remote', () => {
    const result = evaluatePrEligibility({ ...ready, baseExistsOnRemote: false })
    expect(result.eligible).toBe(false)
    expect(result.blockers).toContain('base-missing-on-remote')
  })

  it('blocks on a detached HEAD (no branch) with the no-branch key rather than a false branch-equals-base', () => {
    const result = evaluatePrEligibility({ ...ready, branch: null })
    expect(result.eligible).toBe(false)
    expect(result.blockers).toContain('no-branch')
    expect(result.blockers).not.toContain('branch-equals-base')
  })

  it('reports every unmet condition at once, not just the first — the user sees the whole list', () => {
    const result = evaluatePrEligibility({
      auth: { kind: 'not-authenticated' },
      branch: 'main',
      baseRef: 'main',
      baseExistsOnRemote: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      hasUncommittedChanges: true
    })
    expect(result.eligible).toBe(false)
    expect(new Set(result.blockers)).toEqual(
      new Set([
        'gh-not-authenticated',
        'branch-equals-base',
        'base-missing-on-remote',
        'no-upstream',
        'not-ahead',
        'uncommitted-changes'
      ])
    )
  })

  it('maps every blocker key to an actionable, non-empty message', () => {
    for (const key of result_keys()) {
      expect(PR_BLOCKER_MESSAGES[key]).toBeTruthy()
      expect(PR_BLOCKER_MESSAGES[key].length).toBeGreaterThan(0)
    }
    // The two auth blockers carry distinct, operable guidance — install vs. log in.
    expect(PR_BLOCKER_MESSAGES['gh-not-installed']).not.toBe(PR_BLOCKER_MESSAGES['gh-not-authenticated'])
    expect(PR_BLOCKER_MESSAGES['gh-not-installed'].toLowerCase()).toContain('install')
    expect(PR_BLOCKER_MESSAGES['gh-not-authenticated'].toLowerCase()).toContain('gh auth login')
  })
})

/** Every blocker key the ladder can emit — kept beside the tests so a new key without copy fails here. */
function result_keys(): (keyof typeof PR_BLOCKER_MESSAGES)[] {
  return [
    'gh-not-installed',
    'gh-not-authenticated',
    'no-branch',
    'no-upstream',
    'not-ahead',
    'behind-upstream',
    'branch-equals-base',
    'uncommitted-changes',
    'base-missing-on-remote'
  ]
}
