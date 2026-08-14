import { describe, expect, it } from 'vitest'
import {
  isDuplicateResubmit,
  recordSubmit,
  RESUBMIT_WINDOW_MS,
  type LastSubmit
} from '../src/renderer/src/lib/composer-resubmit-guard.js'

describe('composer-resubmit-guard', () => {
  it('never suppresses when there is no last recorded submit', () => {
    expect(isDuplicateResubmit(null, 'hello', 0, 800)).toBe(false)
  })

  it('suppresses identical text inside the window', () => {
    const last = recordSubmit('hello', 1000)
    expect(isDuplicateResubmit(last, 'hello', 1100, 800)).toBe(true)
  })

  it('does NOT suppress identical text AT the window boundary', () => {
    const last = recordSubmit('hello', 1000)
    // now - last.at === windowMs, and the guard uses strict <, so this is allowed.
    expect(isDuplicateResubmit(last, 'hello', 1000 + 800, 800)).toBe(false)
  })

  it('does NOT suppress identical text after the window', () => {
    const last = recordSubmit('hello', 1000)
    expect(isDuplicateResubmit(last, 'hello', 1000 + 801, 800)).toBe(false)
  })

  it('never suppresses different text, even inside the window', () => {
    const last = recordSubmit('hello', 1000)
    expect(isDuplicateResubmit(last, 'goodbye', 1010, 800)).toBe(false)
  })

  it('treats a whitespace-only difference as the same message (suppressed within window)', () => {
    const last = recordSubmit('hello', 1000)
    expect(isDuplicateResubmit(last, '  hello  \n', 1050, 800)).toBe(true)
  })

  it('round-trips a recorded submit into a suppressed duplicate', () => {
    const last = recordSubmit('deploy now', 5000)
    expect(last).toEqual({ text: 'deploy now', at: 5000 })
    expect(isDuplicateResubmit(last, 'deploy now', 5100, RESUBMIT_WINDOW_MS)).toBe(true)
  })

  // The load-bearing scenario: a real failure is never recorded, so its retry is NOT a duplicate.
  // Component records ONLY non-throwing submits. Model a failed send by leaving `last` unchanged
  // (still null, or still pointing at an earlier, different submit) and assert the retry passes.
  it('allows an identical retry when the prior identical submit was never recorded', () => {
    // Case A: the very first send failed, so nothing was ever recorded.
    const afterFailedFirstSend: LastSubmit = null
    expect(isDuplicateResubmit(afterFailedFirstSend, 'run tests', 200, 800)).toBe(false)

    // Case B: last recorded submit is a DIFFERENT message; a failed "run tests" between them
    // was never recorded, so the retry of "run tests" is not seen as a duplicate.
    const lastRecorded = recordSubmit('setup env', 1000)
    expect(isDuplicateResubmit(lastRecorded, 'run tests', 1050, 800)).toBe(false)
  })
})
