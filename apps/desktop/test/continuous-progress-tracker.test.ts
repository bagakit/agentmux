import { describe, expect, it } from 'vitest'
import { classifyContinuousProgressTracker } from '../src/main/continuous-progress-tracker'

describe('continuous progress tracker adapter', () => {
  it('distinguishes terminal and blocked tracker states', () => {
    expect(classifyContinuousProgressTracker({ status: 'archived' }).state).toBe('archived')
    expect(classifyContinuousProgressTracker({ status: 'blocked', reason: 'dependency' })).toEqual({ state: 'blocked', reason: 'dependency' })
    expect(classifyContinuousProgressTracker({ tasks: [{ status: 'done' }] })).toEqual({ state: 'no-runnable', reason: expect.any(String) })
    expect(classifyContinuousProgressTracker(null).state).toBe('corrupt')
  })
})
