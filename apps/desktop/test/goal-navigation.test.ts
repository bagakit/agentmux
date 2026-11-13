import { describe, expect, it } from 'vitest'
import type { DemandProjection } from '../src/renderer/src/lib/global-demand-board'
import type { GoalGroup } from '../src/renderer/src/lib/goal-groups'
import { adjacentGoalId, goalQueuePosition, stageTransitions } from '../src/renderer/src/lib/goal-navigation'

/**
 * Keyboard and queue movement read the grouped list exactly as it is shown, and the stage cue
 * fires only for a Goal that was already visible and changed group because its facts changed.
 */
const goal = (id: string) => ({ id }) as DemandProjection
const groups: GoalGroup[] = [
  { stage: 'you', goals: [goal('a'), goal('b')] },
  { stage: 'attention', goals: [goal('c')] },
  { stage: 'agents', goals: [goal('d'), goal('e')] }
]

describe('adjacentGoalId', () => {
  it('moves in the reading order across groups', () => {
    expect(adjacentGoalId(groups, 'b', 1)).toBe('c')
    expect(adjacentGoalId(groups, 'c', -1)).toBe('b')
    expect(adjacentGoalId(groups, 'a', 1)).toBe('b')
  })
  it('stops at the ends instead of wrapping', () => {
    expect(adjacentGoalId(groups, 'e', 1)).toBeNull()
    expect(adjacentGoalId(groups, 'a', -1)).toBeNull()
  })
  it('starts at the first or last Goal when nothing is selected', () => {
    expect(adjacentGoalId(groups, null, 1)).toBe('a')
    expect(adjacentGoalId(groups, null, -1)).toBe('e')
  })
  it('returns nothing for an id that is not in the list, and for an empty list', () => {
    expect(adjacentGoalId(groups, 'gone', 1)).toBeNull()
    expect(adjacentGoalId([], null, 1)).toBeNull()
  })
})

describe('goalQueuePosition', () => {
  it('gives the place within its own group and the next Goal waiting in that group', () => {
    expect(goalQueuePosition(groups, 'd')).toEqual({ stage: 'agents', index: 1, total: 2, nextId: 'e' })
    expect(goalQueuePosition(groups, 'e')).toEqual({ stage: 'agents', index: 2, total: 2, nextId: null })
  })
  it('is unknown for a Goal outside the shown list', () => {
    expect(goalQueuePosition(groups, 'gone')).toBeNull()
  })
})

describe('stageTransitions', () => {
  it('reports Goals that were shown before and are now in another group', () => {
    const before = new Map([['a', 'you'], ['c', 'agents'], ['d', 'agents']] as const)
    expect([...stageTransitions(before, groups)]).toEqual(['c'])
  })
  it('stays quiet on first render and for Goals that just appeared', () => {
    expect(stageTransitions(new Map(), groups).size).toBe(0)
    expect(stageTransitions(new Map([['a', 'you']] as const), groups).size).toBe(0)
  })
})
