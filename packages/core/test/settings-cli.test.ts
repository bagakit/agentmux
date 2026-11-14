import { expect, it } from 'vitest'
import { AGENTMUX_CLI_COMMANDS, parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { parseSettingsCommand } from '../src/settings-cli.js'
import { agentMuxModuleSkill } from '../src/agentmux-cli-module-skills.js'

it.each([
  [['inspect'], 'settings.inspect', {}],
  [['inspect', 'appearance'], 'settings.inspect', { target: 'appearance' }],
  [['set', 'copyPathsAsAbsolute', 'true'], 'settings.set', { key: 'copyPathsAsAbsolute', value: 'true' }],
  [['hosts', 'home', '--host', 'exact'], 'settings.hosts.home', { hostId: 'exact' }],
  [['hosts', 'home', '--host', 'exact', '--session', 'Session-Exact'], 'settings.hosts.home', { hostId: 'exact', agentSessionId: 'Session-Exact' }],
  [['hosts', 'home', '--host=exact', '--session=Session-Exact'], 'settings.hosts.home', { hostId: 'exact', agentSessionId: 'Session-Exact' }],
  [['hosts', 'home', '--session', '--help', '--host', 'exact'], 'settings.hosts.home', { hostId: 'exact', agentSessionId: '--help' }],
  [['executors', 'refresh', 'exact', '--host', '--help'], 'settings.executors.refresh', { executorId: 'exact', hostId: '--help' }]
] as const)('selects %s from the one production registry and parses only its parameters', async (args, method, params) => {
  const invocation = await parseAgentMuxCliInvocation(['settings', ...args])
  expect(invocation.command).toBe(AGENTMUX_CLI_COMMANDS.find(command => command.method === method))
  expect(invocation.params).toEqual(params)
  expect(await parseSettingsCommand(args)).toEqual(params)
})

it('keeps malformed input refused by the registered parser without inventing a method', async () => {
  for (const args of [
    ['set', 'appearance.appAppearance'], ['hosts', 'home'], ['inspect', '--unknown'],
    ['hosts', 'home', '--host', 'exact', '--session'],
    ['hosts', 'home', '--host', 'exact', '--session', 'one', '--session', 'two'],
    ['hosts', 'home', '--host', 'exact', '--session', 'one', '--guessed'],
    ['hosts', 'inspect', '--host', 'exact', '--session', 'one'],
    ['hosts', 'network', '--host', 'exact', '--session', 'one']
  ]) {
    await expect(parseAgentMuxCliInvocation(['settings', ...args])).rejects.toMatchObject({ code: 'INVALID_CLI_ARGUMENT' })
  }
})

it('discovers the optional selected home read from the same production registry', async () => {
  const selected = AGENTMUX_CLI_COMMANDS.find(command => command.method === 'settings.hosts.home')!
  expect(selected.usage).toBe('--host <id> [--session <id>]')
  expect(selected.summary).toContain('locator')
  const guide = agentMuxModuleSkill('settings')
  expect(guide).toContain('Add --session SID to the same home read')
  expect(guide).toContain('agentWorkspace')
  expect(guide).toContain('never fall\nback to the home directory as a substitute locator')
  for (const method of ['settings.hosts.inspect', 'settings.hosts.network']) {
    expect(AGENTMUX_CLI_COMMANDS.find(command => command.method === method)!.usage).not.toContain('--session')
  }
})
