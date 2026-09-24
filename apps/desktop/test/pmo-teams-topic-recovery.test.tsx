import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('PMO teams topic recovery', () => {
  it('keeps the exact Topic target and the non-blocking original workface', () => {
    const panel = readFileSync(new URL('../src/renderer/src/components/PmoTeamsTopicFloatingPanel.tsx', import.meta.url), 'utf8')
    const state = readFileSync(new URL('../src/renderer/src/lib/pmo-teams-topic-floating.ts', import.meta.url), 'utf8')
    expect(panel).toContain('topicId={target.topicId}')
    expect(panel).toContain('ensureMote')
    expect(state).toContain('agentmux.leader-topic-floating.v1')
    expect(state).toContain('targetTopicId?: string')
    expect(state).not.toContain('maximized')
    expect(state).not.toContain('position:')
    expect(panel).not.toContain('launcherPosition')
  })
})
