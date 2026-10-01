import { fixturePath as upstreamFixturePath } from './helpers/fixture-values.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentMuxControlServer } from '../src/control-host.js'
import { AgentMuxError } from '../src/errors.js'
import type { AgentMuxControlRequest, AgentMuxControlResult, AgentMuxDemand } from '../src/control.js'
import { AGENTMUX_CLI_COMMANDS, parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { agentMuxPmoPlaybook } from '../src/agentmux-pmo-playbook.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { privateRpcCorePort } from './helpers/private-rpc-core.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { issueAgentCapability, hashAgentCapability } from '../src/agent-capability.js'
import { SELF_CONTEXT_TOPIC_HINT } from '../src/agent-self-context.js'

const goals: AgentMuxDemand[] = [
  { id: 'original-G1', title: 'First', description: 'saved', status: 'in_progress', priority: 'normal', projectId: 'P1', projectName: 'One',
    assigneeExecutorId: 'E1', activityLog: ['original Goal activity'], sessionIds: ['generic-session'], createdAt: 1, updatedAt: 20, source: 'session' },
  { id: 'original-G2', title: 'Second', description: 'saved too', status: 'done', priority: 'low', projectId: 'P2', projectName: 'Two',
    assigneeExecutorId: 'E2', activityLog: ['other Goal activity'], sessionIds: ['other-session'], createdAt: 2, updatedAt: 30, source: 'session' }
]
let root: string, server: AgentMuxControlServer
const seen: AgentMuxControlRequest[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'od-')); seen.length = 0
  server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [],
    async execute(request): Promise<AgentMuxControlResult> {
      seen.push(request)
      if (request.operation === 'demand.list') return { operation: request.operation, demands: structuredClone(goals) }
      if (request.operation === 'demand.show') return { operation: request.operation, demand: goals.find(goal => goal.id === request.demandId) ?? null }
      if (request.operation === 'list.projects') return { operation: request.operation, projects: [
        { projectId: 'P1', name: 'One', hostId: 'fixture', path: root, kind: 'folder', repoPath: null, branch: null, activeAgentSessionIds: [] },
        { projectId: 'P2', name: 'Two', hostId: 'fixture', path: join(root, 'two'), kind: 'folder', repoPath: null, branch: null, activeAgentSessionIds: [] }
      ] }
      if (request.operation === 'inspect.client') return { operation: request.operation, observation: { selectedSurface: 'space', regionIds: ['original-R'] } }
      throw new AgentMuxError('This fixture source is unavailable.', 'CONTROL_UNAVAILABLE')
    },
    async snapshot() { return { workspaces: [{ workspaceId: 'W1', projectId: 'P1', path: root, hostId: 'fixture', name: 'One', kind: 'folder', repoPath: null, branch: null }],
      unavailable: [{ source: 'topics', code: 'TOPIC_FILESYSTEM_UNAVAILABLE', message: 'Exact filesystem source unavailable.', recovery: 'Restore this source.' }] } }
  })
  await server.start()
})
afterEach(async () => { await server?.stop(); if (root) await rm(root, { recursive: true, force: true }) })
const run = (args: readonly string[]) => runCompiledObjectCli(args, objectCliEnvironment(root))

describe('compiled object discovery through the actual public service and original execute port', () => {
  it('keeps nonempty global Project/Workspace/Goal facts while other sources are unavailable', async () => {
    const reply = await run(['app', 'snapshot'])
    expect(reply.code, reply.stderr).toBe(0)
    const body = JSON.parse(reply.stdout)
    expect(body.operation).toBe('app.snapshot')
    expect(body.result.projects.map((project: { projectId: string }) => project.projectId)).toEqual(['P1', 'P2'])
    expect(body.result.workspaces).toEqual([{ workspaceId: 'W1', projectId: 'P1', path: root, hostId: 'fixture', name: 'One', kind: 'folder', repoPath: null, branch: null }])
    expect(body.result.goals.map((goal: { id: string }) => goal.id)).toEqual(['original-G1', 'original-G2'])
    expect(body.result.activity).toEqual([
      { goalId: 'original-G1', message: 'original Goal activity', updatedAt: 20 },
      { goalId: 'original-G2', message: 'other Goal activity', updatedAt: 30 }
    ])
    expect(body.result.unavailable.length).toBeGreaterThan(0)
    expect(body.result.unavailable).toContainEqual(expect.objectContaining({ source: 'topics', code: 'TOPIC_FILESYSTEM_UNAVAILABLE' }))
    expect(seen.map(request => request.operation)).toContain('list.projects')
    expect(seen.map(request => request.operation)).toContain('demand.list')
  })

  it('filters original Goal links/activity through the service and keeps original durable IDs', async () => {
    const listed = await run(['goal', 'ls', '--project', 'P1', '--session', 'generic-session', '--executor', 'E1', '--status', 'in_progress', '--limit', '1'])
    expect(listed.code, listed.stderr).toBe(0)
    expect(JSON.parse(listed.stdout)).toMatchObject({ operation: 'goal.ls', result: { goals: [goals[0]] } })
    const activity = await run(['goal', 'activity', '--goal', 'original-G1', '--project', 'P1', '--session', 'generic-session', '--since', '10'])
    expect(activity.code, activity.stderr).toBe(0)
    expect(JSON.parse(activity.stdout)).toEqual({ ok: true, operation: 'goal.activity', result: {
      activity: [{ goalId: 'original-G1', message: 'original Goal activity', updatedAt: 20 }]
    } })
    const inspected = await run(['goal', 'inspect', '--goal', 'original-G1'])
    expect(inspected.code, inspected.stderr).toBe(0)
    expect(JSON.parse(inspected.stdout)).toEqual({ ok: true, operation: 'goal.inspect', result: { goal: goals[0] } })
    expect(seen.map(request => request.operation)).toEqual(['demand.list', 'demand.list', 'demand.show'])
  })

  it('reads original Desktop facts with exact canonical output, without an Agent caller', async () => {
    const result = await run(['app', 'inspect'])
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, operation: 'app.inspect', result: {
      observation: { selectedSurface: 'space', regionIds: ['original-R'] }
    } })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ operation: 'inspect.client' })
  })

  it('preserves exact Region/Tab debugging facts and verified self, while keeping unavailable presentation separate', async () => {
    await server.stop()
    const capability = issueAgentCapability(), storePath = join(root, 'sessions.json')
    const store = new AgentMuxFileAgentSessionStore(storePath)
    await store.compareAndSwap(null, { kind: 'agent', agentSessionId: 'original-SID', providerId: 'codex', executorId: 'codex',
      hostId: 'local', workspacePath: root, run: { runId: 'original-Run' }, retiredRuns: [], hookBindingId: 'original-hook',
      hookToken: 'synthetic-hook', capabilityHash: hashAgentCapability(capability), createdAt: 1, updatedAt: 1 })
    const core = await privateRpcCorePort(storePath, join(root, 'messages.ndjson'))
    const address = { spaceId: 'S', zoneId: 'Z', workspaceId: 'W', displayWorkspaceId: 'D', groupId: 'G', tabId: 'T', regionId: 'R' }
    const catalog = { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [address] }
    const bounds = { x: 0.1, y: 0.2, width: 0.4, height: 0.4 }
    const neighbors = { left: { kind: 'none' }, right: { kind: 'tab', tabId: 'other-T' }, up: { kind: 'none' }, down: { kind: 'none' } } as const
    const terminalView = { runId: 'original-Run', sampledAt: 123, visible: true, readOnly: false, liveReady: true, acceptsInput: true,
      viewGrid: { cols: 80, rows: 24 }, buffer: { type: 'normal', baseY: 100, viewportY: 40, length: 124 }, mouseTrackingMode: 'none' } as const
    const region = { kind: 'agent', workspaceId: 'W', tabId: 'T', regionId: 'R', agentSessionId: 'original-SID', providerId: 'codex', executorId: 'codex', bounds, neighbors, terminalView } as const
    const file = { kind: 'file', workspaceId: 'W', tabId: 'T', regionId: 'F', path: upstreamFixturePath("literal file"), bounds, neighbors } as const
    const browser = { kind: 'browser', workspaceId: 'W', tabId: 'T', regionId: 'B', browserId: 'original-browser', bounds, neighbors } as const
    const tab = { tabId: 'T', workspaceId: 'W', regions: [region, file, browser] }
    let viewFailure: string | undefined
    server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: core.clients,
      async execute(request): Promise<AgentMuxControlResult> {
        seen.push(request)
        if (request.operation === 'inspect.region' || request.operation === 'inspect.tab') {
          if (viewFailure) throw new AgentMuxError('Original presentation observation unavailable.', viewFailure)
          return request.operation === 'inspect.region' ? { operation: request.operation, region } : { operation: request.operation, tab }
        }
        if (request.operation === 'space.inspect') return { operation: request.operation, catalog }
        throw new Error('Unexpected observation operation: ' + request.operation)
      } })
    await server.start()
    const managed = objectCliEnvironment(root, { AGENTMUX_AGENT_SESSION_ID: 'original-SID', AGENTMUX_AGENT_CAPABILITY: capability })
    try {
      for (const [flag, expected] of [['--region', region], ['--tab', tab]] as const) {
        const reply = await run([ 'space', 'inspect', flag, flag === '--region' ? 'R' : 'T' ])
        expect(reply.code, reply.stderr).toBe(0)
        expect(JSON.parse(reply.stdout).result.presentation[flag.slice(2)]).toEqual(expected)
      }
      const self = await runCompiledObjectCli(['space', 'inspect', '--region', 'self'], managed)
      expect(self.code, self.stderr).toBe(0)
      expect(JSON.parse(self.stdout).result.presentation.region).toEqual(region)
      expect(seen.at(-1)).toMatchObject({ operation: 'space.inspect', target: { regionId: 'R' } })
      const unmanaged = await run(['space', 'inspect', '--region', 'self'])
      expect(unmanaged.code).toBe(1)
      expect(JSON.parse(unmanaged.stderr).error.code).toBe('MANAGED_AGENT_CONTEXT_REQUIRED')
      viewFailure = 'CONTROL_UNAVAILABLE'
      const unknown = await run(['space', 'inspect', '--region', 'R'])
      expect(unknown.code, unknown.stderr).toBe(0)
      expect(JSON.parse(unknown.stdout).result).toEqual({ catalog, presentation: { region: null, tab: null,
        unavailable: [expect.objectContaining({ code: 'CONTROL_UNAVAILABLE' })] } })
      for (const failure of ['CALLER_NOT_OPEN', 'CONTROL_UNAVAILABLE']) {
        viewFailure = failure
        const whoami = await runCompiledObjectCli(['whoami'], managed)
        expect(whoami.code, whoami.stderr).toBe(0)
        const body = JSON.parse(whoami.stdout).result
        expect(body.session).toMatchObject({ agentSessionId: 'original-SID', run: { runId: 'original-Run' }, workspacePath: root })
        expect(body.topic).toBe(SELF_CONTEXT_TOPIC_HINT)
        expect(body.view).toMatchObject({ attached: false, reason: failure === 'CALLER_NOT_OPEN' ? 'no-desktop-view' : 'view-unavailable' })
        expect(body.unavailable).toContainEqual(expect.objectContaining({ code: failure }))
      }
      expect(seen.filter(request => request.operation !== 'inspect.region' && request.operation !== 'inspect.tab' && request.operation !== 'space.inspect')).toEqual([])
    } finally { await core.dispose() }
  })

  it('uses the nonempty actual registration as the read-only manual and help source', async () => {
    expect(AGENTMUX_CLI_COMMANDS.length).toBeGreaterThan(0)
    const playbook = agentMuxPmoPlaybook()
    expect(playbook.readOnly).toBe(true)
    const referenced = [...playbook.document.matchAll(/agentmux ([a-z-]+(?: [a-z-]+)*)/g)]
    expect(referenced.length).toBeGreaterThan(0)
    for (const match of referenced) {
      const path = match[1]!.split(' ')
      expect(AGENTMUX_CLI_COMMANDS.some(command => command.method.split('.').every((part, index) => path[index] === part))).toBe(true)
    }
    const empty = await parseAgentMuxCliInvocation(['agent', 'view', '--session', 'constructor'])
    expect(empty.params).toEqual({ agentSessionId: 'constructor' })
    expect(seen).toEqual([])
  })
})
