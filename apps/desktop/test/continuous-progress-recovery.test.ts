import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { describe, expect, it } from 'vitest'
import { ContinuousProgressScheduler } from '@agentmux/core'

describe('continuous progress recovery', () => {
  it('claims at most one due tick after restore', () => {
    const scheduler = new ContinuousProgressScheduler({ now: () => 0, id: () => 'tick' })
    scheduler.restore([{ loopId: 'l', hostId: 'local', agentSessionId: 'a', providerId: 'codex', workspacePath: _hygiene_fixturePath("w"), intervalMs: 10, prompt: 'continue', nextCheckAt: 1, status: 'active' }])
    expect(scheduler.recover(20)).toHaveLength(1)
    expect(scheduler.recover(20)).toHaveLength(0)
  })
})
