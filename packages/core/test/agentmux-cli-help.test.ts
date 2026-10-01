import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import packageManifest from '../package.json' with { type: 'json' }
import { AGENTMUX_CLI_COMMANDS } from '../src/agentmux-cli-commands.js'
import { AGENTMUX_CLI_SKILL, agentMuxCommandHelp } from '../src/agentmux-cli-help.js'
import { browserPageCapabilityNames } from '../src/browser-page-capability.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { AGENTMUX_AGENT_MESSAGING_GUIDANCE } from '../src/agent-messaging-guidance.js'

let root: string
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'oh-')) })
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })
const run = (args: readonly string[]) => runCompiledObjectCli(args, objectCliEnvironment(root))

describe('compiled object-first CLI help and discovery', () => {
  it('renders every actual registered command, its exact leaf help and its parent objects without a service', async () => {
    const result = await run(['--help'])
    expect(result.code, result.stderr).toBe(0)
    expect(AGENTMUX_CLI_COMMANDS.length).toBeGreaterThan(0)
    for (const command of AGENTMUX_CLI_COMMANDS) {
      const spelling = command.method.replaceAll('.', ' ')
      expect(result.stdout).toContain('agentmux ' + spelling)
      const leaf = await run(['--help', ...command.method.split('.')])
      expect(leaf.code, command.method + ': ' + leaf.stderr).toBe(0)
      expect(leaf.stdout).toContain('Usage: agentmux ' + spelling)
      expect(leaf.stdout).toContain(command.summary)
    }
    const groups = [...new Set(AGENTMUX_CLI_COMMANDS.filter(command => command.method.includes('.')).map(command => command.method.split('.')[0]!))]
    expect(groups.length).toBeGreaterThan(0)
    for (const group of groups) {
      const help = await run([group, '--help'])
      expect(help.code, help.stderr).toBe(0)
      expect(help.stdout).toContain('agentmux ' + group + ' ')
    }
  }, 120_000)

  it('prints the same actual command registration in the skill without retired aliases', async () => {
    const result = await run(['--skill'])
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe(AGENTMUX_CLI_SKILL.trim())
    expect(AGENTMUX_CLI_COMMANDS.length).toBeGreaterThan(0)
    for (const command of AGENTMUX_CLI_COMMANDS) expect(result.stdout).toContain('agentmux ' + command.method.replaceAll('.', ' '))
    for (const old of ['agentmux pmo ', 'agentmux list ', 'agentmux demand ', 'agentmux open ', 'agentmux focus ', 'agentmux send ', 'agentmux roles ', 'agentmux toolkit add ', 'agentmux settings get ']) {
      expect(result.stdout).not.toContain(old)
    }
    expect(result.stdout).not.toContain('--request-id')
    expect(result.stdout).toContain('--project PROJECT')
    expect(result.stdout).toContain('--source-workspace WORKSPACE')
    expect(result.stdout).toContain(AGENTMUX_AGENT_MESSAGING_GUIDANCE)
    expect(agentMuxCommandHelp('agent.send')).toContain(AGENTMUX_AGENT_MESSAGING_GUIDANCE)
  })

  it('keeps wire and business identities, partial writes, caret and manual boundaries explicit', async () => {
    const result = await run(['--skill'])
    expect(result.stdout).toContain('RPC wire IDs only correlate transport messages')
    expect(result.stdout).toContain('Without a complete success reply, the commit result is unconfirmed')
    expect(result.stdout).toContain('do not automatically retry the write')
    expect(result.stdout).toContain('A current read cannot certify an earlier lost receipt')
    expect(result.stdout).toContain('Reader cancellation only detaches that reader')
    expect(result.stdout).toContain('Selection,')
    expect(result.stdout).toContain('changes no SOUL/Wiki/user profile')
    expect(agentMuxCommandHelp('agent.open')).toContain('No existing Tab anchor')
    expect(agentMuxCommandHelp('agent.open')).toContain('Project is an execution resource')
    expect(agentMuxCommandHelp('space.mv')).toContain('Session, Run, Host and cwd')
  })

  it('retains Browser page capabilities and result/transfer recovery from their actual owner', async () => {
    const browser = agentMuxCommandHelp('browser.run')!
    expect(browser.length).toBeGreaterThan(0)
    for (const effect of ['observe', 'act', 'wait', 'navigate'] as const) {
      const names = browserPageCapabilityNames(effect)
      expect(names.length).toBeGreaterThan(0)
      for (const name of names) expect(AGENTMUX_CLI_SKILL).toContain('`' + name + '`')
    }
    expect(browser).toContain('withinRef')
    expect(browser).toContain('missingFrames')
    expect(browser.toLowerCase()).toContain('superseded')
    expect(browser).toContain('readResult')
    expect(browser).toContain('readDownload')
    expect(browser).toContain('uploadFiles')
    expect(browser).toContain('browser inspect --operation-id')
  })

  it('discovers a private endpoint while no server is listening and reports the package version', async () => {
    const endpoint = await run(['system', 'endpoint'])
    expect(endpoint.code, endpoint.stderr).toBe(0)
    expect(JSON.parse(endpoint.stdout)).toEqual({ ok: true, operation: 'system.endpoint', result: {
      protocol: 'jsonrpc-2.0', framing: 'json-lines', endpoint: { transport: 'unix', path: join(root, 'control.sock') }
    } })
    const version = await run(['--version'])
    expect(version.code).toBe(0)
    expect(version.stdout.trim()).toBe('agentmux ' + packageManifest.version)
  })

  it('rejects extra global help arguments and nonexistent command paths honestly', async () => {
    const unknown = await run(['--help', 'unknown', 'command'])
    expect(unknown.code).toBe(1)
    expect(JSON.parse(unknown.stderr).error.code).toBe('INVALID_CLI_ARGUMENT')
    expect(agentMuxCommandHelp('pmo')).toBeNull()
    expect(agentMuxCommandHelp('demand')).toBeNull()
  })
})
