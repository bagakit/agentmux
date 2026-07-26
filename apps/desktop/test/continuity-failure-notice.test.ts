import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { AgentSessionRecoveryCandidate } from '../src/shared/contracts.js'
import {
  classifyContinuityFailure,
  continuityRetryEnabled
} from '../src/renderer/src/lib/continuity-failure-notice.js'
import { recoveryCandidateSession } from '../src/renderer/src/store.js'

// The point of this module is that "resume failed" is not one fact. Core already distinguishes the
// reasons; the renderer used to collapse them into a single disabled "Resume unavailable" button, so
// a Provider that can NEVER resume looked exactly like a Host that is merely offline right now. These
// tests assert the three classes stay distinguishable — and that the remedy matches the class, since
// a retry button on a permanently-unresumable Agent promises something that cannot happen.

describe('continuity failure classes', () => {
  it('says a Provider that cannot resume is permanent, and offers a new Agent', () => {
    const notice = classifyContinuityFailure('unavailable', 'provider-resume-unsupported')

    expect(notice?.remedy).toEqual({ kind: 'start-new' })
    expect(continuityRetryEnabled(notice)).toBe(false)
    // The distinguishing fact: it is the Provider, not this session, and nothing was lost here.
    expect(notice?.reason).toContain('Provider')
    expect(notice?.title).not.toBe('Agent resume unavailable')
  })

  it('scopes a missing resume token to this one Agent', () => {
    const notice = classifyContinuityFailure('unavailable', 'native-handle-unavailable')

    expect(notice?.remedy).toEqual({ kind: 'start-new' })
    // "Other Agents are unaffected" is the whole reason this class is separate from the one above.
    expect(notice?.reason).toContain('Other Agents')
  })

  it('treats a missing Provider as retryable, because it can come back', () => {
    // The one unavailable case that is NOT permanent: install the Provider, or bring the Host back,
    // and the same Agent Session resumes. Telling the user to start a new Agent would throw away a
    // recoverable session.
    const notice = classifyContinuityFailure('unavailable', 'provider-unavailable')

    expect(notice?.remedy).toEqual({ kind: 'retry' })
    expect(continuityRetryEnabled(notice)).toBe(true)
    expect(notice?.reason).toContain('intact')
  })

  it('says a conflict is someone else holding it, not a loss', () => {
    const notice = classifyContinuityFailure('conflict', undefined)

    expect(notice?.remedy).toEqual({ kind: 'wait' })
    expect(continuityRetryEnabled(notice)).toBe(false)
    expect(notice?.title).toContain('another operation')
  })

  it('admits it does not know when Core reports no reason', () => {
    // Honest "we don't know" rather than picking a class. Guessing "Provider unsupported" would send
    // the user to start a new Agent when the truth might be a dropped Host.
    const notice = classifyContinuityFailure('unavailable', undefined)

    expect(notice?.remedy).toEqual({ kind: 'retry' })
    expect(notice?.reason).toContain('did not report')
  })

  it('produces nothing at all when continuity did not fail', () => {
    expect(classifyContinuityFailure(undefined, undefined)).toBeNull()
    expect(continuityRetryEnabled(null)).toBe(false)
  })

  it('keeps every class distinguishable — no two share a title or an action', () => {
    // This is the acceptance criterion itself: 合成一句「恢复失败」等于没说. If a future edit makes
    // two classes render the same words, this is the test that notices.
    const notices = [
      classifyContinuityFailure('unavailable', 'provider-resume-unsupported'),
      classifyContinuityFailure('unavailable', 'native-handle-unavailable'),
      classifyContinuityFailure('unavailable', 'provider-unavailable'),
      classifyContinuityFailure('unavailable', 'unknown-session'),
      classifyContinuityFailure('conflict', undefined)
    ]

    expect(notices.every((notice) => notice !== null)).toBe(true)
    const titles = new Set(notices.map((notice) => notice?.title))
    const reasons = new Set(notices.map((notice) => notice?.reason))
    expect(titles.size).toBe(notices.length)
    expect(reasons.size).toBe(notices.length)
  })

  it('never offers a button that cannot work', () => {
    // A retry that is guaranteed to fail is worse than a disabled button: it promises a result.
    for (const reason of ['provider-resume-unsupported', 'native-handle-unavailable', 'unknown-session'] as const) {
      expect(continuityRetryEnabled(classifyContinuityFailure('unavailable', reason))).toBe(false)
    }
  })
})

describe('the store actually carries Core’s reason to the surface', () => {
  // Asserting the classifier alone proves nothing about the seam this task is about: a test that
  // seeds `continuityReason` into a fixture stays green even if the store never writes it. These
  // assert the RETURNED projection, so dropping the field in store.ts turns them red.
  function candidate(): AgentSessionRecoveryCandidate {
    return {
      agentSessionId: 'agent-1',
      hostId: 'local',
      workspacePath: '/repo',
      providerId: 'codex',
      executorId: 'codex',
      capabilities: {
        terminal: true,
        hookEvents: true,
        timeline: 'complete-events',
        permission: 'observe',
        providerResume: true,
        acp: false,
        replyCorrelation: 'none'
      },
      label: 'Codex',
      createdAt: 1,
      updatedAt: 1,
      run: { runId: 'run-1' }
    }
  }

  it('projects each unavailable reason onto the Session snapshot', () => {
    for (const reason of [
      'provider-resume-unsupported',
      'native-handle-unavailable',
      'provider-unavailable',
      'unknown-session'
    ] as const) {
      const session = recoveryCandidateSession(candidate(), {
        kind: 'unavailable',
        agentSessionId: 'agent-1',
        previousRun: { runId: 'run-1' },
        reason,
        evidence: { kind: 'run-missing', observedAt: 1 }
      })

      expect(session.status.continuity).toBe('unavailable')
      expect(session.status.continuityReason).toBe(reason)
      // And the reason must survive far enough to change what the user is told.
      expect(classifyContinuityFailure('unavailable', session.status.continuityReason)).not.toBeNull()
    }
  })

  it('leaves the reason absent for a conflict, which is its own reason', () => {
    const session = recoveryCandidateSession(candidate(), {
      kind: 'conflict',
      agentSessionId: 'agent-1',
      previousRun: { runId: 'run-1' },
      currentRun: { runId: 'run-2' }
    })

    expect(session.status.continuity).toBe('conflict')
    expect(session.status.continuityReason).toBeUndefined()
  })
})
