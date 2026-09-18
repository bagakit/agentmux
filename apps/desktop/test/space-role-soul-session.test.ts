import { mkdtemp, readFile, realpath, rm, unlink, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  AgentMuxClient,
  AgentMuxMemoryAgentSessionStore,
  AgentProviderRegistry,
  defineAgentProvider
} from '@agentmux/core'
import type { AgentMuxAgentSessionRegistry } from '../../../packages/core/src/agent-session-registry'
import type { CtxmuxAdapterRun, CtxmuxRunAdapter } from '../../../packages/core/src/ctxmux-run-adapter'
import { ScratchTopics } from '../src/main/scratch-topics'
import { RuntimeController } from '../src/main/runtime-controller'
import type { AppConfig, WorkspaceRecord } from '../src/shared/contracts'
import { MOTE_SOUL_PATH, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'

// Keep the real Desktop controller, Core lifecycle, provider planning, outbound envelope,
// Session store and filesystem. Only transport/host selection is isolated from user Runs.
const host = vi.hoisted(() => ({ client: null as unknown }))
vi.mock('@agentmux/core', async (original) => ({
  ...await original<typeof import('@agentmux/core')>(),
  connectLocalAgentMux: async () => host.client
}))
vi.mock('../src/main/host-factory.js', () => ({
  createExecutionHost: () => ({ kind: 'local', dispose: async () => {} })
}))

type StartInput = Parameters<CtxmuxRunAdapter['start']>[0]

type Internals = {
  connected: boolean
  registry: AgentMuxAgentSessionRegistry
  kernel: {
    isConnected(): boolean
    identity(): { daemonInstanceId: string; buildIdentity: string; protocolVersion: number }
    start(input: StartInput): Promise<CtxmuxAdapterRun>
    list(): Promise<CtxmuxAdapterRun[]>
    status(runId: string): Promise<CtxmuxAdapterRun>
    prepareStop(runId: string): Promise<{ daemonInstance: string; operationKey: string; runId: string }>
    stop(input: { runId: string }): Promise<void>
  }
}

const disposals: Array<() => Promise<void>> = []
const roots: string[] = []
afterEach(async () => {
  await Promise.all(disposals.splice(0).map(dispose => dispose()))
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmux-soul-session-'))); roots.push(root)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const workspace: WorkspaceRecord = { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', path: root, kind: 'folder' }
  const topics = new ScratchTopics()
  const template = new AgentProviderRegistry().get('codex')
  const providers = ['soul-fixture-a', 'soul-fixture-b'].map(id => defineAgentProvider({
    catalog: { ...template.catalog, id, label: id, executable: id, expectedProcess: id,
      hookStrategy: { kind: 'none' }, readySignal: { kind: 'foreground-process', expectedProcess: id } },
    hook: { rules: [], eventNameSource: { kind: 'payload', payloadKey: 'hook_event_name' } },
    buildArgs: (prompt, args) => [...args, prompt],
    buildResumeArgs: (sessionId, _transcript, prompt, args) => [...args, '--resume', sessionId, ...(prompt ? [prompt] : [])]
  }))
  const store = new AgentMuxMemoryAgentSessionStore()
  const core = new AgentMuxClient({ store, providers })
  const inner = core as unknown as Internals
  inner.connected = true
  await inner.registry.load('local')
  vi.spyOn(core, 'connect').mockResolvedValue()
  vi.spyOn(core, 'probeAgent').mockImplementation(async id => ({
    providerId: id, installed: true, executable: id, capabilities: core.providers.get(id).catalog.capabilities
  }))
  const starts: StartInput[] = []
  const runs = new Map<string, CtxmuxAdapterRun>()
  inner.kernel.isConnected = () => true
  inner.kernel.identity = () => ({ daemonInstanceId: 'isolated-soul-adapter', buildIdentity: 'fixture', protocolVersion: 1 })
  inner.kernel.start = async input => {
    starts.push(input)
    const run: CtxmuxAdapterRun = { runId: `soul-run-${starts.length}`, lifecycleOperationId: input.operationKey,
      program: input.program, args: input.args, workspacePath: input.cwd, pid: 10_000 + starts.length,
      state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0 }
    runs.set(run.runId, run)
    return run
  }
  inner.kernel.list = async () => [...runs.values()]
  inner.kernel.status = async id => {
    const run = runs.get(id)
    if (!run) throw new Error(`Fixture Run absent: ${id}`)
    return run
  }
  inner.kernel.prepareStop = async runId => ({ daemonInstance: 'isolated-soul-adapter', operationKey: `stop-${runId}`, runId })
  inner.kernel.stop = async operation => { runs.delete(operation.runId) }
  const stop = vi.spyOn(core, 'stopAgent')
  host.client = core
  const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Isolated fixture' }],
    executors: Object.fromEntries(providers.map(provider => [provider.id, { label: provider.label, providerId: provider.id,
      command: provider.executable, args: [], env: {}, injectAgentMuxGuide: false }])),
    workspaces: [workspace, { id: 'project-a', name: 'Project A', hostId: 'local', path: join(root, 'project-a'), kind: 'folder' },
      { id: 'project-b', name: 'Project B', hostId: 'local', path: join(root, 'project-b'), kind: 'folder' }],
    appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  const controller = new RuntimeController(store, topics)
  controller.commit(await controller.prepare(config))
  disposals.push(() => controller.dispose())
  const launch = (topicId: string, sessionId: string, prompt: string, executorId = providers[0]!.id) => controller.launchAgent({
    executorId, hostId: 'local', workspacePath: root, scratchTopicId: topicId, agentSessionId: sessionId, prompt
  }, config)
  return { root, workspace, topics, core, inner, config, controller, starts, runs, stop, launch }
}

it('delivers saved SOUL through the product controller and actual Core envelope to distinct Sessions with one global Mote identity', async () => {
  const h = await fixture()
  const moteId = 'launcher:durable-mote'
  const created = await h.topics.ensureMote(h.workspace, moteId)
  const directory = join(h.root, created.directoryPath)
  const soulPath = join(directory, MOTE_SOUL_PATH)
  expect(h.core.agentSessions()).toEqual([])
  expect(created.id).toBe(moteId)
  const soulOne = '# SOUL\n\nSpeak as the patient cartographer.\n'
  await writeFile(soulPath, soulOne)
  const current = (await h.topics.read(h.workspace, moteId))!
  const first = await h.launch(moteId, 'execution-one', 'Coordinate Project A and its delivery Topic.')
  expect(first.session.id).toBe('execution-one')
  expect(h.starts).toHaveLength(1)
  expect(h.starts[0]!.cwd).toBe(directory)
  const delivered = h.starts[0]!.args.at(-1)!
  expect(delivered).toContain(`<amux from="amux">`)
  expect(delivered).toContain(`Mote personality from SOUL.md (version ${current.soul!.version})`)
  expect(delivered).toContain(`Your persistent Mote identity is ${moteId}`)
  expect(delivered).toContain('across Projects and Topics through the available AgentMux capabilities')
  expect(delivered).toContain(soulOne)
  expect(delivered).toContain('Current user instructions, authorization, actual capabilities')
  expect(delivered).toContain('Choose how to organize your knowledge and durable notes')
  expect(delivered.indexOf('</amux>')).toBeGreaterThan(-1)
  expect(delivered.slice(delivered.indexOf('</amux>'))).toContain('Coordinate Project A and its delivery Topic.')

  const soulTwo = '# SOUL\n\nSpeak as the precise navigator.\n'
  await writeFile(soulPath, soulTwo)
  const second = await h.launch(moteId, 'execution-two', 'Coordinate Project B.', 'soul-fixture-b')
  expect(second.session.id).toBe('execution-two')
  expect(h.starts).toHaveLength(2)
  expect(h.starts[1]!.cwd).toBe(directory)
  expect(h.starts[1]!.args.at(-1)).toContain(soulTwo)
  expect(h.starts[1]!.args.at(-1)).not.toContain(soulOne)
  expect(h.starts[1]!.args.at(-1)).toContain(`Your persistent Mote identity is ${moteId}`)
  expect(h.starts[0]!.args.at(-1)).toBe(delivered)
  await h.controller.stopSession(first.session.control)
  await h.controller.stopSession(second.session.control)
  expect(h.core.agentSessions()).toEqual([])
  const remaining = await h.topics.read(h.workspace, moteId)
  expect(remaining).toMatchObject({ id: moteId, directoryPath: created.directoryPath, soul: { content: soulTwo } })
  expect(await readFile(soulPath, 'utf8')).toBe(soulTwo)
  const replacement = await h.launch(moteId, 'execution-three', 'Continue the two Project outcomes.')
  expect(replacement.session.id).toBe('execution-three')
  expect(h.starts).toHaveLength(3)
  expect(h.starts[2]!.cwd).toBe(directory)
  expect(h.starts[2]!.args.at(-1)).toContain(`Your persistent Mote identity is ${moteId}`)
})

it('recovers the same native Session and home without pretending the edited SOUL hot-updated its original context', async () => {
  const h = await fixture()
  const moteId = 'launcher:recover-mote'
  const mote = await h.topics.ensureMote(h.workspace, moteId)
  const soulPath = join(h.root, mote.directoryPath, MOTE_SOUL_PATH)
  await writeFile(soulPath, '# SOUL\n\nOriginal personality.\n')
  const first = await h.launch(moteId, 'recover-session', 'Coordinate all authorized Projects.')
  const firstStart = structuredClone(h.starts[0]!)
  const stored = h.inner.registry.get(first.session.id)
  // Native Provider identity is an authoritative fixture fact; Core still owns resume planning.
  await h.inner.registry.put({ ...stored, nativeHandle: { kind: 'provider', providerId: stored.providerId, sessionId: 'original-native-session' } }, stored.run)
  await writeFile(soulPath, '# SOUL\n\nEdited personality for future Sessions.\n')
  const read = vi.spyOn(h.topics, 'prepareAgent')
  const attached = await h.controller.recoverSession(first.session.control, h.config, undefined, 'attach-existing')
  expect(attached).toMatchObject({ kind: 'reattachable', session: { id: first.session.id, workspacePath: firstStart.cwd, control: { run: first.session.control.run } } })
  expect(h.starts).toEqual([firstStart])
  h.runs.set(stored.run.runId, { ...h.runs.get(stored.run.runId)!, state: { type: 'exited', code: 0, signal: null } })
  const resumed = await h.controller.recoverSession(first.session.control, h.config, undefined, 'resume-existing')
  expect(resumed).toMatchObject({ kind: 'resumed', session: { id: first.session.id, workspacePath: firstStart.cwd } })
  expect(h.core.agentSession(first.session.id).nativeHandle).toEqual({ kind: 'provider', providerId: stored.providerId, sessionId: 'original-native-session' })
  expect(h.starts).toHaveLength(2)
  expect(h.starts[1]).toMatchObject({ cwd: firstStart.cwd, args: ['--resume', 'original-native-session'],
    env: expect.objectContaining({ AGENTMUX_WIKI_DIR: firstStart.cwd }) })
  expect(read).not.toHaveBeenCalled()
  expect(h.starts[0]).toEqual(firstStart)
  expect(await h.topics.read(h.workspace, moteId)).toMatchObject({ id: moteId,
    soul: { content: '# SOUL\n\nEdited personality for future Sessions.\n' } })
})

it('isolates personalities and exposes a new-launch file failure while preserving a healthy Session and its Mote files', async () => {
  const h = await fixture()
  const moteA = await h.topics.ensureMote(h.workspace, 'launcher:mote-a')
  const moteB = await h.topics.ensureMote(h.workspace, 'launcher:mote-b')
  const soulA = '# SOUL\n\nPersonality A only.\n'
  const soulB = '# SOUL\n\nPersonality B only.\n'
  await writeFile(join(h.root, moteA.directoryPath, MOTE_SOUL_PATH), soulA)
  await writeFile(join(h.root, moteB.directoryPath, MOTE_SOUL_PATH), soulB)
  const healthy = await h.launch(moteA.id, 'healthy-a', 'Help Project A.')
  await h.launch(moteB.id, 'healthy-b', 'Help Project B.')
  expect(h.starts).toHaveLength(2)
  expect(h.starts[0]!.args.at(-1)).toContain(soulA)
  expect(h.starts[0]!.args.at(-1)).not.toContain(soulB)
  expect(h.starts[1]!.args.at(-1)).toContain(soulB)
  expect(h.starts[1]!.args.at(-1)).not.toContain(soulA)
  await h.launch('launcher:ordinary', 'ordinary-session', 'Work inside this Topic.')
  expect(h.starts).toHaveLength(3)
  expect(h.starts[2]!.args.at(-1)).not.toContain('Mote personality')
  expect(h.starts[2]!.args.at(-1)).not.toContain(soulA)
  expect(h.starts[2]!.args.at(-1)).not.toContain(soulB)
  // A path exists but cannot be read as a regular SOUL file. This fails before any new Run starts.
  const damagedPath = join(h.root, moteA.directoryPath, MOTE_SOUL_PATH)
  await unlink(damagedPath); await mkdir(damagedPath)
  await expect(h.launch(moteA.id, 'not-created', 'New launch.')).rejects.toThrow(/SOUL\.md/)
  expect(h.starts).toHaveLength(3)
  expect(h.stop).not.toHaveBeenCalled()
  expect((await h.core.statusAgent(healthy.session.id)).run).toMatchObject({ runId: healthy.session.control.run.runId, state: 'running' })
  expect(h.core.agentSessions().map(session => session.agentSessionId)).toEqual(['healthy-a', 'healthy-b', 'ordinary-session'])
  expect(await h.controller.recoverSession(healthy.session.control, h.config, undefined, 'healthy-despite-soul-load-failure'))
    .toMatchObject({ kind: 'reattachable', session: { id: healthy.session.id, control: healthy.session.control } })
  expect(h.stop).not.toHaveBeenCalled()
  const listed = await h.topics.list(h.workspace)
  expect(listed).toHaveLength(3)
  expect(listed.find(topic => topic.id === moteA.id)).toMatchObject({ id: moteA.id,
    directoryPath: scratchTopicDirectoryName(moteA.id), readError: expect.stringContaining('SOUL.md') })
  expect(listed.find(topic => topic.id === moteB.id)).toMatchObject({ id: moteB.id, soul: { content: soulB } })
  expect(await readFile(join(h.root, moteA.directoryPath, 'topic.md'), 'utf8')).toContain('Untitled Mote')
})
