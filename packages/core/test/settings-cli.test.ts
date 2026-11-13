import { expect, it } from 'vitest'
import { AGENTMUX_CLI_COMMANDS, parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { parseSettingsCommand } from '../src/settings-cli.js'

it.each([
  [['inspect'], 'settings.inspect', {}],
  [['inspect', 'appearance'], 'settings.inspect', { target: 'appearance' }],
  [['set', 'copyPathsAsAbsolute', 'true'], 'settings.set', { key: 'copyPathsAsAbsolute', value: 'true' }],
  [['hosts', 'home', '--host', 'exact'], 'settings.hosts.home', { hostId: 'exact' }],
  [['executors', 'refresh', 'exact', '--host', '--help'], 'settings.executors.refresh', { executorId: 'exact', hostId: '--help' }]
] as const)('selects %s from the one production registry and parses only its parameters', async (args, method, params) => {
  const invocation = await parseAgentMuxCliInvocation(['settings', ...args])
  expect(invocation.command).toBe(AGENTMUX_CLI_COMMANDS.find(command => command.method === method))
  expect(invocation.params).toEqual(params)
  expect(await parseSettingsCommand(args)).toEqual(params)
})

it('keeps malformed input refused by the registered parser without inventing a method', async () => {
  for (const args of [['set', 'appearance.appAppearance'], ['hosts', 'home'], ['inspect', '--unknown']]) {
    await expect(parseAgentMuxCliInvocation(['settings', ...args])).rejects.toMatchObject({ code: 'INVALID_CLI_ARGUMENT' })
  }
})
