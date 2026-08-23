import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('PMO teams topic recovery', () => {
  it('keeps the fixed Topic and the non-blocking launcher path', () => {
    const panel = readFileSync(new URL('../src/renderer/src/components/PmoTeamsTopicFloatingPanel.tsx', import.meta.url), 'utf8')
    const state = readFileSync(new URL('../src/renderer/src/lib/pmo-teams-topic-floating.ts', import.meta.url), 'utf8')
    expect(panel).toContain('PMO_TEAMS_TOPIC_ID')
    expect(panel).toContain('ensureTopic')
    expect(state).toContain('pmo-teams-topic-floating.v1')
    expect(state).toContain('launcherPosition')
  })
})
