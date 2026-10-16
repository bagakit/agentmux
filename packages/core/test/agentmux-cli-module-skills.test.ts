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
import { AGENTMUX_AGENT_MESSAGING_GUIDANCE } from '../src/agent-messaging-guidance.js'
import { AGENT_OPEN_WORKFLOW, DIAGNOSTIC_GUIDE, NATIVE_RESUME_GUIDE, SPATIAL_GUIDE } from '../src/agentmux-cli-shared-guides.js'
import { AGENTMUX_BROWSER_PROGRAM_GUIDE, AGENTMUX_BROWSER_TARGET_GUIDE, AGENTMUX_BROWSER_TASK_GUIDE } from '../src/agentmux-cli-browser-guide.js'
import { browserPageCapabilityNames } from '../src/browser-page-capability.js'
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

  it('routes short domain entries to complete purpose-specific contracts without eager handbooks', () => {
    const roots = agentMuxCliModuleCatalog().map(module => module.root)
    expect(roots.length).toBeGreaterThan(1)
    expect(AGENTMUX_CLI_SKILL).toContain('if you know the domain, skip this directory')
    for (const full of [AGENTMUX_AGENT_MESSAGING_GUIDANCE, SPATIAL_GUIDE, NATIVE_RESUME_GUIDE, AGENT_OPEN_WORKFLOW])
      expect(AGENTMUX_CLI_SKILL).not.toContain(full)
    for (const root of roots) {
      const document = agentMuxModuleSkill(root)!
      if (root !== 'message') expect(document, root).not.toContain(AGENTMUX_AGENT_MESSAGING_GUIDANCE)
      if (root !== 'space') expect(document, root).not.toContain(SPATIAL_GUIDE)
    }
    expect(agentMuxModuleSkill('message')).toContain(AGENTMUX_AGENT_MESSAGING_GUIDANCE)
    expect(agentMuxModuleSkill('space')).toContain(SPATIAL_GUIDE)
    expect(agentMuxModuleSkill('system')).toContain(DIAGNOSTIC_GUIDE)
    const agent = agentMuxModuleSkill('agent')!
    for (const route of ['amux message --skill', 'amux agent native --help', 'amux agent open --help'])
      expect(agent).toContain(route)
    expect(agent).not.toContain(NATIVE_RESUME_GUIDE)
    expect(agent).not.toContain(AGENT_OPEN_WORKFLOW)
    expect(agentMuxCommandHelp('agent.native')).toContain(NATIVE_RESUME_GUIDE)
    expect(agentMuxCommandHelp('agent.open')).toContain(AGENT_OPEN_WORKFLOW)
    const browser = agentMuxModuleSkill('browser')!
    for (const route of ['amux browser targets --help', 'amux browser run --help', 'amux browser task --help', 'amux space --skill'])
      expect(browser).toContain(route)
    for (const guide of [AGENTMUX_BROWSER_PROGRAM_GUIDE, AGENTMUX_BROWSER_TARGET_GUIDE, AGENTMUX_BROWSER_TASK_GUIDE])
      expect(browser).not.toContain(guide)
    expect(agentMuxCommandHelp('browser.targets')).toContain(AGENTMUX_BROWSER_TARGET_GUIDE)
    expect(agentMuxCommandHelp('browser.task')).toContain(AGENTMUX_BROWSER_TASK_GUIDE)
    const program = agentMuxCommandHelp('browser.run')!
    expect(program).toContain(AGENTMUX_BROWSER_PROGRAM_GUIDE)
    for (const effect of ['observe', 'act', 'wait', 'navigate'] as const)
      for (const name of browserPageCapabilityNames(effect)) expect(program).toContain(name)
    const file = agentMuxModuleSkill('file')!
    for (const route of ['amux file write --help', 'amux file restore --help', 'amux file undo --help']) expect(file).toContain(route)
    expect(file).not.toContain('noteConflictUnavailable')
    expect(agentMuxCommandHelp('file.write')).toContain('noteConflictUnavailable')
    expect(agentMuxCommandHelp('file.restore')).toContain('contentUnavailable')
    expect(agentMuxCommandHelp('file.undo')).toContain('For a confirmed original creation batch')
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

  it('actual Note help and Files skill agree on first-use shared Markdown and both read-only inspection modes', async () => {
    const note = await run(['--endpoint', endpoint, 'notebook', '--help'])
    const file = await run(['--endpoint', endpoint, 'file', '--skill'])
    expect(note.code, note.stderr).toBe(0); expect(file.code, file.stderr).toBe(0)
    for (const contract of ['::note-include', 'kind: shared-block', 'Copy/hover never creates an entity', 'forwardedBlockIds', 'mode:"request"', 'mode:"shared"', 'An absent whole batch stays unknown']) expect(note.stdout).toContain(contract)
    expect(note.stdout).not.toContain('A block stays inside its original file when referenced')
    expect(file.stdout).toContain('amux file share --help')
    expect(file.stdout).toContain('A current matching file cannot certify')
    expect(connections).toBe(0)
    expect((await readdir(root, { recursive: true })).sort()).toEqual(originalFiles)
  })

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
    expect(browser.stdout).toContain('amux browser run --help')
    const program = await run(['--endpoint', dead, '--help', 'browser', 'run'])
    expect(program.code, program.stderr).toBe(0)
    expect(program.stdout.trim()).toBe(agentMuxCommandHelp('browser.run')!.trim())
    expect(program.stdout).toContain('readResult')
    expect(program.stdout).toContain('browser inspect --operation-id')
    expect(connections).toBe(0)
    expect((await readdir(root, { recursive: true })).sort()).toEqual(originalFiles)
  })

  it('actual compiled Mote skill and PMO manual retain cooperation, memory and delivery duties offline', async () => {
    const dead = `unix:${join(root, 'never-started.sock')}`
    // The live trap proves zero connections; the dead address also proves no reachable owner is needed.
    for (const selectedEndpoint of [endpoint, dead]) {
      const mote = await run(['--endpoint', selectedEndpoint, 'mote', '--skill'])
      expect(mote.code, mote.stderr).toBe(0); expect(mote.stderr).toBe('')
      for (const duty of [
        'before asking for a persona', 'source, date and evidence links',
        'save with that revision/CAS and read back', 'source-only withdrawal marker',
        'existing discussions keep their earlier context', 'authorized secure storage path',
        'do not persist the secret', 'amux mote playbook pmo', 'amux goal --skill'
      ]) expect(mote.stdout, duty).toContain(duty)

      const pmo = await run(['--endpoint', selectedEndpoint, 'mote', 'playbook', 'pmo'])
      expect(pmo.code, pmo.stderr).toBe(0); expect(pmo.stderr).toBe('')
      const result = JSON.parse(pmo.stdout)
      expect(result).toMatchObject({ ok: true, operation: 'mote.playbook.pmo', result: { readOnly: true, format: 'markdown' } })
      const manual = result.result.document as string
      for (const duty of [
        'Keep that original ID', 'Registration does not\ncreate a directory or instructions',
        'initial-instruction path', 'bind the actual Executor and Session',
        'Implement personally only when the user explicitly asks',
        'collect\nthe original delegated reports', 'manual names, manual clears, launch names',
        'do not complete\nthe business Goal', 'amux goal --skill'
      ]) expect(manual, duty).toContain(duty)
      expect(manual).toContain(goalRoleGuidance({ role: 'manager' }))
      expect(manual).not.toContain('## Executor responsibilities')
    }
    expect(connections).toBe(0)
    expect((await readdir(root, { recursive: true })).sort()).toEqual(originalFiles)
  })

  it('PMO operational references use the actual registered command syntax', () => {
    const manual = agentMuxPmoPlaybook().document
    const lines = manual.split('\n').filter(line => line.startsWith('amux '))
    expect(lines.length).toBeGreaterThan(0)
    const referenced = new Set<string>()
    for (const line of lines) {
      const command = AGENTMUX_CLI_COMMANDS.find(item => {
        const prefix = 'amux ' + item.method.replaceAll('.', ' ')
        return line === prefix || line.startsWith(prefix + ' ')
      })
      expect(command, line).toBeDefined()
      expect(line).toBe(`amux ${command!.method.replaceAll('.', ' ')}${command!.usage ? ' ' + command!.usage : ''}`)
      referenced.add(command!.method)
    }
    for (const method of ['goal.create', 'goal.inspect', 'goal.update', 'settings.workspaces.register',
      'agent.open', 'goal.delegate', 'goal.report', 'goal.collect', 'agent.rename', 'space.rename'])
      expect(referenced.has(method), method).toBe(true)
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
