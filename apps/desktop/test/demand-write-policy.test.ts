import { describe, expect, it } from 'vitest'
import { demandWriteDecision } from '../src/renderer/src/lib/demand-write-policy.js'

describe('task write confirmation policy', () => {
  it('blocks unknown routing instead of guessing a project', () => {
    expect(demandWriteDecision({ mode: 'risk-confirm', risk: 'low', projectKnown: false, hasConfirmation: false })).toBe('blocked')
  })
  it('requires confirmation for high risk and permits explicit confirmation', () => {
    expect(demandWriteDecision({ mode: 'risk-confirm', risk: 'high', projectKnown: true, hasConfirmation: false })).toBe('confirm')
    expect(demandWriteDecision({ mode: 'risk-confirm', risk: 'high', projectKnown: true, hasConfirmation: true })).toBe('automatic')
  })
})
