import { describe, expect, it } from 'vitest'
import { clusterConversationAxis, conversationAxis, speaksAsHuman, type ConversationAxisMark } from '../src/renderer/src/lib/conversation-axis'
import type { AgentTimelineItem } from '../src/shared/contracts'

const items = [0, 100, 100, 900, 1000].map((at, index): AgentTimelineItem => ({
  id: `record-${index}`, agentSessionId: 'self', kind: 'user_message', status: 'complete',
  source: 'user', createdAt: at, updatedAt: at, title: 'Message', content: 'Identical original body'
}))
const marks = conversationAxis(items, speaksAsHuman)

describe('conversation axis density', () => {
  it('preserves every repeated-time and repeated-body record with its original index and object', () => {
    const groups = clusterConversationAxis(marks, 300)
    const members = groups.flatMap(group => group.members)
    expect(members.map(mark => mark.index)).toEqual([0, 1, 2, 3, 4])
    expect(groups.map(group => group.members.length)).toEqual([3, 2])
    members.forEach(mark => expect(mark.item).toBe(items[mark.index]))
    expect(groups.map(group => group.fraction)).toEqual([0.05, 0.95])
  })
  it('uses the measured hit geometry without changing single event positions', () => {
    const wide = clusterConversationAxis(marks, 1000)
    expect(wide.map(group => group.members.length)).toEqual([1, 2, 1, 1])
    expect(wide[0]!.fraction).toBe(marks[0]!.fraction)
    expect(wide.at(-1)!.fraction).toBe(marks.at(-1)!.fraction)
    expect(clusterConversationAxis(marks, 300)).toHaveLength(2)
  })
  it('keeps original record order within non-monotonic temporal clusters and never mutates input', () => {
    const shuffled: ConversationAxisMark[] = [marks[2]!, marks[0]!, marks[4]!, marks[1]!, marks[3]!]
    const before = [...shuffled]
    const groups = clusterConversationAxis(shuffled, 300)
    expect(groups.flatMap(group => group.members).map(mark => mark.index)).toEqual([0, 1, 2, 3, 4])
    expect(shuffled).toEqual(before)
    expect(marks.map(mark => mark.fraction)).toEqual([0, 0.1, 0.1, 0.9, 1])
  })
  it('retains the unmeasured, sparse and empty pathways', () => {
    for (const width of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(clusterConversationAxis(marks, width).map(group => group.members)).toEqual(marks.map(mark => [mark]))
    }
    expect(clusterConversationAxis([], 300)).toEqual([])
    expect(clusterConversationAxis([marks[0]!, marks[4]!], 300).map(group => group.fraction)).toEqual([0, 1])
  })
})
