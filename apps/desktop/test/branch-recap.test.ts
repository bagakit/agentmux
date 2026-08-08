import { describe, expect, it } from 'vitest'
import { boardRowRecap } from '../src/renderer/src/lib/project-board'
describe('Branch and Topic recap', () => {
  it('uses the Topic summary and Branch latest activity detail through one projection', () => {
    expect(boardRowRecap({ kind: 'topic', topic: { summary: 'Plan release' } } as never)).toBe('Plan release')
    expect(boardRowRecap({ kind: 'branch', sessions: [{ status: { detail: 'Running tests' } }] } as never)).toBe('Running tests')
  })
  it('does not invent a recap when the source has none', () => {
    expect(boardRowRecap({ kind: 'branch', sessions: [] } as never)).toBeNull()
    expect(boardRowRecap({ kind: 'topic', topic: { summary: '' } } as never)).toBeNull()
  })
})
