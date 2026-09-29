// @vitest-environment happy-dom
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { URL as NodeURL, fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getAppMetrics: () => [] } }))
import { AgentMuxMemoryAgentSessionStore, type AgentMuxClient, type AgentMuxAgentCreateInput } from '@agentmux/core'
import { openDemandStore } from '@agentmux/demand'
import { ScratchTopics } from '../src/main/scratch-topics'
import { RuntimeController } from '../src/main/runtime-controller'
import { executeSettingsWorkspaceAddControl } from '../src/main/settings-workspace-add-control'
import { MOTE_COORDINATION_ROLE, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { configOwnerFixture } from './helpers/config-owner-fixture'
import { AGENTMUX_CLI_SKILL, agentMuxCommandHelp } from '../../../packages/core/src/agentmux-cli-help'

const roots: string[] = []
const initial = useAppStore.getState()
afterEach(async () => { vi.restoreAllMocks(); useAppStore.setState(initial, true); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const request = (value: Record<string, unknown>) => ({ schemaVersion: 5 as const, requestId: crypto.randomUUID(), ...value })

describe('Mote coordination reaches original execution owners', () => {
  it('publishes every actual Demand creation routing flag and distinguishes Project discovery from Workspace registration', async () => {
    const source = await readFile(fileURLToPath(new NodeURL('../../../packages/core/src/agentmux.ts', import.meta.url)), 'utf8')
    const start = source.indexOf("if (action === 'create')"), end = source.indexOf("if (action === 'update')", start)
    expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start)
    const creation = source.slice(start, end)
    expect(creation).toContain("operation: 'demand.create'")
    const flags = [...creation.matchAll(/'(--[a-z-]+)': '(?:data|value)'/g)].map(match => match[1]!)
    expect(flags.length).toBeGreaterThan(0)
    const help = agentMuxCommandHelp('demand')
    expect(help).toBeTruthy()
    for (const flag of flags) expect(help).toContain(flag)
    for (const flag of ['--risk', '--confirm', '--wiki-version']) expect(AGENTMUX_CLI_SKILL).toContain(flag)
    expect(help).toContain('use its exact projectId')
    expect(help).toContain('Workspace id; it is not the Project id')
    expect(help).toContain('risk=unknown and confirmation=pending')
    expect(help).toContain('do not confirm the Goal alignment or accept its results')
  })

  it('passes actual fresh Mote Notes independently from original user text and retains created identity when projection is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-mote-notes-')); roots.push(root)
    const topics = new ScratchTopics(), topicId = 'launcher:source-proof'
    const scratch = { id: SCRATCH_WORKSPACE_ID, name: 'Scratch', hostId: 'local', path: root, kind: 'folder' as const }
    await topics.ensureMote(scratch, topicId)
    const input: AgentMuxAgentCreateInput[] = []
    const created = { kind: 'agent' as const, agentSessionId: 'private-mote', providerId: 'codex', executorId: 'fixture', hostId: 'local', workspacePath: root, run: { runId: 'private-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1 }
    const client = { connect: async () => {}, onEvent: () => () => {}, dispose: async () => {}, createAgentWithDelivery: async (value: AgentMuxAgentCreateInput) => { input.push(value); return { session: created, creation: { createOperationId: 'private-create', initialPrompt: 'confirmed' } } }, runtimeSubject: async () => { throw new Error('Private projection unavailable') }, sessionTimeline: async () => { throw new Error('Private timeline unavailable') } } as unknown as AgentMuxClient
    const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), topics)
    runtime.commit({ hosts: [{ id: 'local', client, executionHost: { kind: 'local', dispose: async () => {} } as never }], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
    const config = { hosts: [{ id: 'local', kind: 'local', label: 'Private' }], workspaces: [scratch], executors: { fixture: { providerId: 'codex', label: 'Private', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } } } as AppConfig
    const prompt = '我有一些点子，我们开始尝试一个项目'
    try {
      const result = await runtime.launchAgent({ hostId: 'local', workspacePath: root, executorId: 'fixture', scratchTopicId: topicId, agentSessionId: created.agentSessionId, prompt }, config)
      expect(input).toHaveLength(1)
      expect(input[0]!.agentMuxNote).toContain(MOTE_COORDINATION_ROLE)
      expect(input[0]!.prompt).toBe(prompt)
      expect(input[0]!.workspacePath).not.toBe(root)
      expect(result.created).toEqual(created)
      expect(result.projectionFailures.map(value => value.step)).toEqual(['session', 'timeline'])
      const ordinary = await topics.prepareAgent(scratch, 'view:ordinary', { providerId: 'codex', sessionId: 'ordinary' })
      expect(ordinary.prompt).not.toContain(MOTE_COORDINATION_ROLE)
    } finally { await runtime.dispose() }
  })

  it('registers real initial instructions, assigns through public Control, and persists only an actual nonempty execution Session link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-mote-handoff-')); roots.push(root)
    const projectPath = join(root, 'project'); await mkdir(projectPath)
    await writeFile(join(projectPath, 'AGENTS.md'), '# Authorized attempt\nCreate result.txt containing HELLO. Report its path; the person accepts the result.\n')
    const f = await configOwnerFixture({ workspaces: [], executors: { fixture: { providerId: 'codex', label: 'Private', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } } })
    const registration = await executeSettingsWorkspaceAddControl({ ...request({}), operation: 'settings.workspaces.add', input: { hostId: 'local', path: projectPath, name: 'Private attempt' } }, f.owner, () => ({}))
    expect(registration.item.id.length).toBeGreaterThan(0)
    expect(await readFile(join(registration.item.value.path, 'AGENTS.md'), 'utf8')).toContain('the person accepts')
    const demands = openDemandStore({ root: join(root, 'demands') })
    for (const [key, method] of Object.entries({ list: 'list', create: 'create', update: 'update', linkSession: 'linkSession', unlinkSession: 'unlinkSession', activity: 'addActivity', decision: 'addDecision' })) vi.spyOn(api.demands, key as 'list').mockImplementation((demands[method as keyof typeof demands] as Function).bind(demands))
    useAppStore.setState({ ...initial, config: f.owner.current, sessions: [], demands: {}, activeWorkspaceId: 'kept-user-surface', mainSurface: 'goals' }, true)
    const control = useAppStore.getState().executeControl
    const discovery = await control({ ...request({}), operation: 'list.projects' } as never)
    if (discovery.operation !== 'list.projects') throw new Error('Wrong Project receipt')
    expect(discovery.projects).toHaveLength(1)
    const projectId = discovery.projects[0]!.projectId
    const created = await control({ ...request({}), operation: 'demand.create', title: 'Authorized attempt', description: `Read ${projectPath}/AGENTS.md and create result.txt`, projectId, decision: { input: 'Explicit authorized bounded attempt', sourceSessionId: null, candidates: [], selectedProjectId: projectId, risk: 'low', confirmation: 'automatic', wikiVersion: null, at: 1 } } as never)
    if (created.operation !== 'demand.create') throw new Error('Wrong Demand receipt')
    const assigned = await control({ ...request({}), operation: 'demand.assign', demandId: created.demand.id, projectId, assigneeExecutorId: 'fixture', start: false } as never)
    expect(assigned.operation).toBe('demand.assign')
    await expect(control({ ...request({}), operation: 'demand.link-session', demandId: created.demand.id, sessionId: 'absent' } as never)).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
    const session = { id: 'actual-fixture-session', kind: 'agent', hostId: 'local', executorId: 'fixture', providerId: 'codex', workspacePath: projectPath, processState: 'running', control: { kind: 'agent', hostId: 'local', agentSessionId: 'actual-fixture-session', run: { runId: 'actual-fixture-run' } } } as SessionSnapshot
    useAppStore.setState({ sessions: [session] })
    const linked = await control({ ...request({}), operation: 'demand.link-session', demandId: created.demand.id, sessionId: session.id } as never)
    if (linked.operation !== 'demand.link-session') throw new Error('Wrong Session receipt')
    expect(linked.demand.sessionIds).toEqual([session.id])
    expect((await demands.get(created.demand.id))?.sessionIds).toEqual([session.id])
    expect((await demands.get(created.demand.id))?.executorId).toBe('fixture')
    expect(useAppStore.getState().activeWorkspaceId).toBe('kept-user-surface')
    expect((await demands.get(created.demand.id))?.alignment?.confirmedAt).toBeUndefined()
  })
})
