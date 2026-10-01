import { describe, expect, it } from 'vitest'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'

describe('Goal CLI carries real service filters', () => {
  it('carries every original routing filter without guessing UI or cwd scope', async () => {
    const parsed = await parseAgentMuxCliInvocation(['goal', 'ls', '--status', 'done', '--project', 'P', '--executor', 'E', '--session', 'SID', '--since', '10', '--limit', '3'])
    expect(parsed.command.method).toBe('goal.ls')
    expect(parsed.params).toEqual({ status: 'done', projectId: 'P', executorId: 'E', agentSessionId: 'SID', since: 10, limit: 3 })
    expect((await parseAgentMuxCliInvocation(['goal', 'ls'])).params).toEqual({})
  })
})
