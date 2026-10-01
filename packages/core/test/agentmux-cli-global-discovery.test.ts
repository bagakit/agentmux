import { describe, expect, it } from 'vitest'
import { agentMuxCommandHelp, AGENTMUX_CLI_HELP } from '../src/agentmux-cli-help.js'
import { AGENTMUX_CLI_COMMANDS, parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'

describe('global object discovery has one executable registration', () => {
  it('documents the original global sources and canonical drill-downs', () => {
    const help = agentMuxCommandHelp('app.snapshot')
    expect(help?.length).toBeGreaterThan(0)
    for (const source of ['Project', 'Workspace', 'Topic', 'Mote', 'Space', 'Zone', 'Executor', 'Session', 'Goal']) expect(help).toContain(source)
    for (const path of ['agent inspect', 'goal activity', 'space inspect']) expect(AGENTMUX_CLI_HELP).toContain('agentmux ' + path)
    expect(agentMuxCommandHelp('pmo')).toBeNull()
  })
  it('carries actual global filters and has no inferred current Workspace', async () => {
    const matching = AGENTMUX_CLI_COMMANDS.filter(command => command.method === 'app.snapshot')
    expect(matching).toHaveLength(1)
    const invocation = await parseAgentMuxCliInvocation(['app', 'snapshot', '--include', 'projects,topics,goals', '--workspace', 'W', '--topic', 'T', '--session', 'SID', '--goal', 'G'])
    expect(invocation.command).toBe(matching[0])
    expect(invocation.params).toEqual({ workspaceId: 'W', topicId: 'T', agentSessionId: 'SID', goalId: 'G', include: ['projects', 'topics', 'goals'] })
    expect((await parseAgentMuxCliInvocation(['app', 'snapshot'])).params).toEqual({})
  })
})
