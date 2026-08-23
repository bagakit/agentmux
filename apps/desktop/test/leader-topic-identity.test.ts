import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('PMO Teams Topic identity', () => {
  it('uses the fixed product topic instead of the current Scratch topic', async () => {
    const source = await readFile(fileURLToPath(new URL('../src/renderer/src/components/PmoTeamsTopicFloatingPanel.tsx', import.meta.url)), 'utf8')
    expect(source).toContain('PMO_TEAMS_TOPIC_ID')
    expect(source).toContain('SCRATCH_WORKSPACE_ID')
    expect(source).toContain('topicIsolation="bound-only"')
  })
})
