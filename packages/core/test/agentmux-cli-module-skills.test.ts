import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AGENTMUX_CLI_COMMANDS, parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { AGENTMUX_CLI_SKILL, agentMuxCommandHelp } from '../src/agentmux-cli-help.js'
import { agentMuxCliModuleCatalog, agentMuxModuleSkill, agentMuxModuleSkillEntry } from '../src/agentmux-cli-module-skills.js'
import { AGENTMUX_GOAL_SKILL_ENTRY, goalRoleGuidance, goalRoleGuidanceContract } from '../src/goal-role-guidance.js'
import { agentMuxPmoPlaybook } from '../src/agentmux-pmo-playbook.js'
import { ObjectCliProbe, objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

let root: string
let server: Server
let connections = 0
let originalFiles: string[]
let endpoint: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'amux-skills-'))
  const socket = join(root, 'read-trap.sock')
  await writeFile(join(root, 'original-user-draft.txt'), 'Retain the original user material.\n')
  server = createServer(stream => { connections++; stream.destroy() })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
  endpoint = `unix:${socket}`
  originalFiles = (await readdir(root, { recursive: true })).sort()
})
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  if (root) await rm(root, { recursive: true, force: true })
})

const run = (args: readonly string[]) => runCompiledObjectCli(args, objectCliEnvironment(root, {
  // Local guidance must not need complete managed credentials, even with an endpoint present.
  AGENTMUX_AGENT_SESSION_ID: 'original-session-without-capability'
}))

describe('local progressive AgentMux module skills', () => {
  it('covers the nonempty actual command roots with owned guidance and discoverable leaf help', () => {
    const roots = [...new Set(AGENTMUX_CLI_COMMANDS.map(command => command.method.split('.')[0]!))]
    expect(roots.length).toBeGreaterThan(1)
    expect(roots).toContain('goal')
    expect(roots).toContain('browser')
    const catalog = agentMuxCliModuleCatalog()
    expect(catalog.map(module => module.root)).toEqual(roots)
    for (const module of catalog) {
      expect(module.summary.length).toBeGreaterThan(0)
      expect(module.roles.length).toBeGreaterThan(0)
      expect(module.when.length).toBeGreaterThan(0)
      expect(module.summary).not.toContain('unavailable')
      expect(module.readCommand).toBe(`amux ${module.root} --skill`)
      expect(agentMuxModuleSkillEntry(module.root)).toBe(module.readCommand)
      const document = agentMuxModuleSkill(module.root)
      expect(document).not.toBeNull()
      expect(document).toContain(`name: amux-${module.root}\n`)
      expect(document).toContain(`# ${module.root} module`)
      expect(document).toContain('## Current command contract')
      expect(document).toContain(`amux ${module.root} --help`)
    }
    expect(AGENTMUX_CLI_COMMANDS.length).toBeGreaterThan(roots.length)
    for (const command of AGENTMUX_CLI_COMMANDS) {
      const help = agentMuxCommandHelp(command.method)
      expect(help, command.method).toContain(command.summary)
      expect(help, command.method).toContain(`Module guide (local, read-only): amux ${command.method.split('.')[0]} --skill`)
    }
  })

  it('actual compiled CLI reads every selected module locally without connecting or creating work', async () => {
    const catalog = agentMuxCliModuleCatalog()
    expect(catalog.length).toBeGreaterThan(1)
    for (const module of catalog) {
      const result = await run(['--endpoint', endpoint, module.root, '--skill'])
      expect(result.code, module.root + ': ' + result.stderr).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).toContain(`name: amux-${module.root}\n`)
      expect(result.stdout).toContain(module.summary)
      expect(result.stdout.trim()).toBe(agentMuxModuleSkill(module.root)!.trim())
    }
    expect(connections).toBe(0)
    expect((await readdir(root, { recursive: true })).sort()).toEqual(originalFiles)
  }, 30_000)

  it('actual compiled base discovery lists roots and delegates domain guidance without connecting', async () => {
    const result = await run(['--endpoint', endpoint, '--skill'])
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe(AGENTMUX_CLI_SKILL.trim())
    const roots = [...new Set(AGENTMUX_CLI_COMMANDS.map(command => command.method.split('.')[0]!))]
    expect(roots.length).toBeGreaterThan(1)
    for (const name of roots) expect(result.stdout).toContain(`amux ${name} --skill`)
    const leaves = AGENTMUX_CLI_COMMANDS.filter(command => command.method.includes('.'))
    expect(leaves.length).toBeGreaterThan(0)
    for (const command of leaves) expect(result.stdout).not.toContain('amux ' + command.method.replaceAll('.', ' ') + ' ')
    expect(result.stdout).not.toContain('## Delegation and opening playbook')
    expect(result.stdout).not.toContain('## Executor responsibilities')
    expect(result.stdout).not.toContain('Page capabilities come from the actual owner')
    expect(connections).toBe(0)
    expect((await readdir(root, { recursive: true })).sort()).toEqual(originalFiles)
  })

  it('actual Goal and Browser reads succeed against a dead endpoint before credential or Runtime checks', async () => {
    const dead = `unix:${join(root, 'never-started.sock')}`
    const goal = await run(['--endpoint', dead, 'goal', '--skill'])
    const browser = await run(['--endpoint', dead, 'browser', '--skill'])
    expect(goal.code, goal.stderr).toBe(0)
    expect(browser.code, browser.stderr).toBe(0)
    expect(goal.stdout).toContain(goalRoleGuidanceContract())
    expect(browser.stdout).toContain('readResult')
    expect(browser.stdout).toContain('browser inspect --operation-id')
    expect(connections).toBe(0)
    expect((await readdir(root, { recursive: true })).sort()).toEqual(originalFiles)
  })

  it('rejects only invalid local module reads and preserves literal --skill command data', async () => {
    for (const module of ['not-registered', '__proto__', 'constructor', 'goal.inspect', 'Goal']) {
      expect(agentMuxModuleSkill(module)).toBeNull()
      const result = await run(['--endpoint', endpoint, module, '--skill'])
      expect(result.code, module).toBe(1)
      expect(result.stdout).toBe('')
      expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, error: {
        code: 'INVALID_CLI_ARGUMENT', message: 'Unknown module. Run amux --skill for the local module directory.'
      } })
    }
    const message = await parseAgentMuxCliInvocation(['agent', 'send', '--to-session', 'SID', '--text', '--skill'])
    expect(message.command.method).toBe('agent.send')
    expect(message.params).toMatchObject({ target: { kind: 'agent-session', agentSessionId: 'SID' }, text: '--skill' })
    const file = await parseAgentMuxCliInvocation(['file', 'open', '--path', '--skill', '--zone', 'ZONE'])
    expect(file.command.method).toBe('file.open')
    expect(file.params.path).toBe('--skill')
    expect(connections).toBe(0)
    expect((await readdir(root, { recursive: true })).sort()).toEqual(originalFiles)
  })

  it('uses one Goal role contract for the module and default handbook and preserves exact source context', () => {
    const context = { role: 'manager' as const, goalId: 'G /\n--goal other', agentSessionId: 'SID-original',
      runId: 'RUN-original', source: { kind: 'patrol', operationId: 'OP-original', messageId: 'M-original', threadId: 'T-original' } }
    const guidance = goalRoleGuidance(context)
    const line = guidance.split('\n').find(value => value.startsWith('Known original context: '))!
    expect(JSON.parse(line.slice('Known original context: '.length))).toEqual({ goalId: context.goalId,
      agentSessionId: context.agentSessionId, runId: context.runId, source: context.source })
    expect(guidance).toContain(`Required module: ${AGENTMUX_GOAL_SKILL_ENTRY}`)
    expect(agentMuxPmoPlaybook().document).toContain(goalRoleGuidance({ role: 'manager' }))
    expect(agentMuxModuleSkill('goal')).toContain(goalRoleGuidanceContract())
    expect(goalRoleGuidance({ role: 'executor' })).toContain('Return delivery evidence for every delegated criterion')
    expect(guidance).toContain('perform the inspection')
    expect(guidance).toContain('do not complete a Goal')
  })

  it('actual compiled CLI keeps literal --skill input on the original command route', async () => {
    // Only the Unix transport receipt is controlled; no business owner applies these writes.
    const probe = new ObjectCliProbe()
    await probe.start()
    try {
      const message = await probe.run(['--endpoint', `unix:${probe.socketPath}`, 'agent', 'send',
        '--to-session', 'SID', '--text', '--skill', '--operation-id', 'original-literal-message'])
      expect(message.code, message.stderr).toBe(1)
      expect(JSON.parse(message.stderr)).toMatchObject({ operation: 'agent.send', error: { code: 'CLI_ROUTE_PROBE' } })
      const file = await probe.run(['--endpoint', `unix:${probe.socketPath}`, 'file', 'open', '--path', '--skill',
        '--zone', 'ZONE', '--operation-id', 'original-literal-file'])
      expect(file.code, file.stderr).toBe(1)
      expect(JSON.parse(file.stderr)).toMatchObject({ operation: 'file.open', error: { code: 'CLI_ROUTE_PROBE' } })
      expect(probe.requests).toHaveLength(2)
      expect(probe.requests[0]).toMatchObject({ method: 'agent.send', params: {
        target: { kind: 'agent-session', agentSessionId: 'SID' }, text: '--skill', operationId: 'original-literal-message'
      } })
      expect(probe.requests[1]).toMatchObject({ method: 'file.open', params: { path: '--skill', operationId: 'original-literal-file' } })
    } finally { await probe.stop() }
  })
})
