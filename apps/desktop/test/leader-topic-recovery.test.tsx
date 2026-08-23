import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('Leader Topic recovery', () => {
  it('keeps the fixed Topic and the non-blocking launcher path', () => {
    const panel = readFileSync(new URL('../src/renderer/src/components/LeaderTopicFloatingPanel.tsx', import.meta.url), 'utf8')
    const state = readFileSync(new URL('../src/renderer/src/lib/leader-topic-floating.ts', import.meta.url), 'utf8')
    expect(panel).toContain('LEADER_TOPIC_ID')
    expect(panel).toContain('ensureTopic')
    expect(state).toContain('leader-topic-floating.v1')
    expect(state).toContain('launcherPosition')
  })
})
