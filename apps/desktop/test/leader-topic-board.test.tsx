import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('Leader Topic demand caller', () => {
  it('uses the fixed Topic identity and the existing task CLI seam', () => {
    const panel = readFileSync(new URL('../src/renderer/src/components/LeaderTopicFloatingPanel.tsx', import.meta.url), 'utf8')
    expect(panel).toContain('LEADER_TOPIC_ID')
    expect(panel).toContain('openScratchTopic(LEADER_TOPIC_ID, SCRATCH_WORKSPACE_ID)')
    expect(panel).toContain('api.scratch.ensureTopic')
  })
})
