import { fixturePath as upstreamFixturePath } from './helpers/fixture-values.js'
import { describe, expect, it } from 'vitest'
import { AGENTMUX_CLI_COMMANDS, parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { AGENTMUX_CLI_HELP, AGENTMUX_CLI_SKILL, agentMuxCommandHelp } from '../src/agentmux-cli-help.js'
import { objectCliSeed } from './helpers/object-cli-rpc.js'

describe('device intents in the actual object CLI registration', () => {
  it('parses all five original intents with exact parameters and no approval or operation identity', async () => {
    const commands = AGENTMUX_CLI_COMMANDS.filter(command => command.method.startsWith('device.'))
    expect(commands.map(command => command.method)).toEqual(['device.ls', 'device.invite', 'device.approve', 'device.reject', 'device.revoke'])
    const parsed = await Promise.all(commands.map(command => parseAgentMuxCliInvocation([
      ...command.method.split('.'), ...objectCliSeed(command.method, upstreamFixturePath("fixture/input.json"))
    ])))
    expect(parsed.map(invocation => [invocation.command.method, invocation.params])).toEqual([
      ['device.ls', {}], ['device.invite', {}],
      ['device.approve', { deviceId: 'DEVICE', confirmationCode: '012345' }],
      ['device.reject', { deviceId: 'DEVICE' }], ['device.revoke', { deviceId: 'DEVICE' }]
    ])
  })

  it('keeps opaque IDs and confirmation codes literal and leaves transport authority to the public client', async () => {
    const invocation = await parseAgentMuxCliInvocation([
      '--endpoint', 'ssh://private-host', 'device', 'approve', '--device', '--help', '--confirmation-code', '--confirm'
    ])
    expect(invocation.command.method).toBe('device.approve')
    expect(invocation.params).toEqual({ deviceId: '--help', confirmationCode: '--confirm' })
    expect(invocation.endpoint).toBe('ssh://private-host')
    expect((await parseAgentMuxCliInvocation(['device', 'revoke', '--device=constructor'])).params)
      .toEqual({ deviceId: 'constructor' })
  })

  it('rejects missing, duplicate and foreign authorization flags rather than passing them as permission facts', async () => {
    const invalid = [
      ['ls', '--device', 'DEVICE'], ['invite', '--confirm'], ['invite', '--operation-id', 'OP'],
      ['approve', '--device', 'DEVICE'], ['approve', '--confirmation-code', '012345'],
      ['approve', '--device', 'DEVICE', '--device', 'OTHER', '--confirmation-code', '012345'],
      ['approve', '--device', 'DEVICE', '--confirmation-code', '012345', '--confirmation-code', '654321'],
      ['approve', '--device', '', '--confirmation-code', '012345'],
      ['approve', '--device', 'DEVICE', '--confirmation-code', '012345', '--approved', 'true'],
      ['reject', '--device', 'DEVICE', '--principal', 'user'],
      ['revoke', '--device', 'DEVICE', '--caller', 'user'],
      ['revoke', '--device', 'DEVICE', '--transport', 'unix']
    ]
    expect(invalid.length).toBeGreaterThan(0)
    for (const args of invalid) await expect(parseAgentMuxCliInvocation(['device', ...args]))
      .rejects.toMatchObject({ code: 'INVALID_CLI_ARGUMENT' })
  })

  it('derives discovery from the same registration and explains the actual Host confirmation and lost-reply boundary', () => {
    const methods = AGENTMUX_CLI_COMMANDS.filter(command => command.method.startsWith('device.')).map(command => command.method)
    expect(methods).toEqual(['device.ls', 'device.invite', 'device.approve', 'device.reject', 'device.revoke'])
    const help = agentMuxCommandHelp('device')!
    expect(help.length).toBeGreaterThan(0)
    for (const method of methods) {
      const spelling = 'agentmux ' + method.replaceAll('.', ' ')
      expect(help).toContain(spelling)
      expect(AGENTMUX_CLI_HELP).toContain(spelling)
      expect(AGENTMUX_CLI_SKILL).toContain(spelling)
      expect(agentMuxCommandHelp(method)).toContain('A Unix connection identifies the request origin; it is not user approval.')
    }
    expect(help).toContain('--device ID --confirmation-code CODE')
    expect(help).toContain('actual local OS confirmation')
    expect(help).toContain('Managed Agents, ordinary approved devices, HTTP and SSH cannot administer devices.')
    expect(help).toContain('read agentmux device ls')
    expect(help).toContain('Do not automatically retry device invite, approve, reject or revoke.')
  })
})
