import { describe, expect, it } from 'vitest'
import { buildActivityGroups } from '../src/renderer/src/lib/activity-groups'

describe('activity workline density', () => {
  it('keeps ordinary running rows concise while preserving actionable reasons', () => {
    const sessions = [{ id: 'a', kind: 'agent', hostId: 'local', workspacePath: '/w', status: { state: 'working', source: 'native-hook', observedAt: 1 } }] as any
    const groups = buildActivityGroups(sessions, [])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.sessions).toHaveLength(1)
  })
})
