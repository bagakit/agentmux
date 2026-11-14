import { afterEach, expect, it, vi } from 'vitest'
import { appendFile, readFile, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createMoteInputFixture, moteInputTestSource } from '../../../packages/core/test/helpers/mote-input-owner.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { AgentMuxNotesStorage } from '../../../packages/core/src/notes-storage.js'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { MoteDialogueStore } from '../../../packages/core/src/mote/dialogue-store.js'
import { parseMoteDialogueResult } from '../../../packages/core/src/mote/dialogue-contract.js'
import { runSourceObjectCli } from '../../../packages/core/test/helpers/source-object-cli.js'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { parseAgentMuxCliInvocation } from '../../../packages/core/src/agentmux-cli-commands.js'
import { agentMuxModuleSkill } from '../../../packages/core/src/agentmux-cli-module-skills.js'
import { MOTE_INPUT_GUIDANCE } from '../../../packages/core/src/mote/input-source.js'
import { MOTE_COORDINATION_ROLE } from '../src/mote-topic-model.js'
import { createHostContent } from '../src/content-owner.js'
import { createHostMoteMainReader, createHostMoteDialogue } from '../src/mote-dialogue.js'
import { motePresenceSourceId } from '@agentmux/core/mote-preferences'
import { serializeMoteQuickMode } from '../src/mote-model.js'
import { createGoalRuntime } from '../src/goal-runtime.js'
import { ContinuousProgressLoopManager } from '../src/continuous-progress-loop-manager.js'
import { ContinuousProgressLoopStore } from '../src/continuous-progress-loop-store.js'

const closes: Array<() => Promise<unknown>> = [], roots: string[] = []
const fact = async (value: unknown) => { if (process.env.MOTE_WORK_FACTS) await appendFile(process.env.MOTE_WORK_FACTS, JSON.stringify(value) + '\n') }
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) { await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' }); await fact({ kind: 'cleanup', root, absent: true }) }
})
async function fixture(options: { mainHostId?: string; restoredUnknown?: boolean } = {}) {
  const f = await createMoteInputFixture(); roots.push(f.root); closes.push(f.close)
  const mainHostId = options.mainHostId ?? 'local'
  const remote = mainHostId !== 'local' ? await rpcOwnerFixture(['remote-main']) : null
  if (remote) { roots.push(remote.root); closes.push(remote.close) }
  const mainSessionId = remote ? 'remote-main' : 'primary'
  if (mainHostId !== 'local') await writeFile(f.motePath, serializeMoteQuickMode(await readFile(f.motePath, 'utf8'), { conversation: {
    hostId: mainHostId, sessionId: mainSessionId, displayWorkspaceId: '__scratch__', groupId: 'group', tabId: 'tab-primary', regionId: 'region-primary' } }))
  // The Core owner is connected under this original Host route; its own Session metadata remains local to that owner.
  const coreClients = () => [...f.coreClients(), ...(remote ? [{ hostId: mainHostId, client: remote.client }] : [])]
  const configurationPath = join(f.root, 'configuration.json')
  const content = createHostContent({ configurationPath, spatial: f.spatial,
    storage: new AgentMuxNotesStorage(join(f.root, 'work-notes-location.json'), join(f.root, 'work-notes')) })
  const main = createHostMoteMainReader({ configurationPath, spatial: f.spatial, files: content.files! })
  const store = new MoteDialogueStore(join(f.root, 'work-dialogue.sqlite'))
  const dialogue = createHostMoteDialogue({ main, spatial: f.spatial, store, clientForHost: () => f.client })
  const runtime = createGoalRuntime({ clients: coreClients, checkIn: async () => ({ known: false, reason: 'This fixture reads arrangements only.' }) })
  const scheduleStore = new ContinuousProgressLoopStore(join(f.root, 'work-schedules.json'))
  const newManager = () => new ContinuousProgressLoopManager(scheduleStore,
    async () => { throw Error('A read must not dispatch automatic input') }, () => 100000, runtime.observeContinuousProgress, runtime)
  if (options.restoredUnknown) {
    const previous = newManager()
    let retained!: import('../../../packages/core/src/continuous-progress-scheduler.js').ContinuousProgressLoop
    try {
      const { schedule } = await previous.call('schedule.create', { target: { hostId: mainHostId, agentSessionId: mainSessionId, providerId: 'codex', workspacePath: remote?.root ?? f.root },
        operationId: 'retained-original-arrangement', everyMs: 60000, prompt: 'Original private retained work' }, { principal: { kind: 'user', id: 'private-original-owner' } })
      const paused = await previous.call('schedule.pause', { scheduleId: schedule.loopId, expectedRevision: schedule.revision!, operationId: 'retained-original-pause' }, { principal: { kind: 'user', id: 'private-original-owner' } })
      // A retained unknown is fixture data at its original durable owner, never inferred from the display text.
      retained = { ...paused.schedule, lastOutcome: 'unknown' }
    } finally { await previous.stop() }
    await scheduleStore.save([retained])
  }
  const schedules = newManager()
  await schedules.start(); closes.push(() => schedules.stop())
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'work-discovery.sock'), coreClients,
    moteDialogue: dialogue, spatialState: f.spatial, schedules })
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: { agentSessionId: 'primary', capability: f.capability } })
  closes.push(() => rpc.dispose())
  const person = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  closes.push(() => person.dispose())
  const target = { spaceId: moteInputTestSource.spaceId, zoneId: moteInputTestSource.zoneId,
    expectedResource: { hostId: 'local', workspaceId: '__scratch__', workspacePath: join(f.root, 'scratch') } }
  const execution = (agentSessionId = mainSessionId) => ({ hostId: mainHostId, agentSessionId, providerId: 'codex', workspacePath: remote?.root ?? f.root })
  const create = async (operationId: string, agentSessionId = mainSessionId, managedSource?: { sourceId: string; revision: string }) =>
    (await person.call('schedule.create', { target: execution(agentSessionId), operationId, everyMs: 60000,
      prompt: 'Private original prompt ' + operationId, ...(managedSource ? { managedSource } : {}) })).schedule
  const read = (limit?: number) => rpc.call('space.mote.dialogue.supervision.read', { target, ...(limit === undefined ? {} : { limit }) })
  const cli = async (input: unknown) => {
    const result = await runSourceObjectCli(['--endpoint', 'unix://' + server.path, 'space', 'mote', 'dialogue', 'supervision', 'read', '--input', '-'],
      objectCliEnvironment(f.root, { AGENTMUX_AGENT_SESSION_ID: 'primary', AGENTMUX_AGENT_CAPABILITY: f.capability,
        ...(process.env.MOTE_WORK_CLI_TRACE ? { AGENTMUX_RESUMED_INBOX_CLI_LOADED: process.env.MOTE_WORK_CLI_TRACE } : {}) }), JSON.stringify(input), 30000,
      new URL('../../../packages/core/test/fixtures/a2a-resumed-inbox/source-loader.mjs', import.meta.url))
    expect(result.code, result.stdout + result.stderr).toBe(0)
    return JSON.parse(result.stdout).result as Awaited<ReturnType<typeof read>>
  }
  return { ...f, main, store, dialogue, schedules, rpc, person, target, execution, create, read, cli }
}
async function linkOriginalWork(f: Awaited<ReturnType<typeof fixture>>) {
  const main = await f.main.readCurrentMoteMain(f.target)
  for (const args of [
    ['agent', 'send', '--to-session', 'member', '--text', 'Original independent work', '--message-id', 'original-work-message', '--operation-id', 'send-original-work-message', '--thread', 'original-work-thread'],
    ['message', 'dispatch', 'open', '--source-message', 'original-work-message']
  ]) { const parsed = await parseAgentMuxCliInvocation(args); await f.rpc.call(parsed.command.method as 'agent.send', parsed.params as never) }
  await f.rpc.call('space.mote.dialogue.link', { target: f.target, operationId: 'link-original-work', expectedRoleRevision: main.roleRevision!,
    source: { kind: 'work', messageHostId: 'local', messageId: 'original-work-message' } })
}

it('actual SDK and source CLI discover own original arrangements with empty linked work and preserve source/status privacy', async () => {
  const f = await fixture(), main = await f.main.readCurrentMoteMain(f.target)
  const normal = await f.create('original-own'), paused = await f.create('original-paused')
  await f.rpc.call('schedule.pause', { scheduleId: paused.loopId, expectedRevision: paused.revision!, operationId: 'explicit-pause' })
  const foreign = await f.create('unrelated-session', 'stranger')
  const source = { sourceId: motePresenceSourceId(main.identity!), revision: main.roleRevision! }
  const old = await f.create('old-role-maintenance', 'primary', { ...source, revision: source.revision + '-old' })
  await f.person.call('schedule.cancel', { scheduleId: old.loopId, expectedRevision: old.revision!, operationId: 'stop-original-old-role' })
  const maintenance = await f.create('current-mote-maintenance', 'primary', source)
  const otherManaged = await f.create('other-original-managed', 'primary', { sourceId: 'other-original-source', revision: 'other-original-role' })
  const inspect = vi.spyOn(f.client, 'inspectAgentInput'), calls = vi.spyOn(f.schedules, 'call')
  const page = await f.read(), viaCli = await f.cli({ target: f.target })
  expect(page.links).toEqual([]); expect(page.observations).toEqual([])
  expect(page.arrangements).toMatchObject({ ownerHostId: 'local', sourceStatus: 'read', coverage: 'current-main-schedules', hasMore: false, issue: null })
  const entries = page.arrangements.entries
  expect(entries.map(row => row.scheduleId).sort()).toEqual([normal.loopId, paused.loopId, old.loopId, otherManaged.loopId].sort())
  expect(entries.find(row => row.scheduleId === paused.loopId)?.status).toBe('paused')
  expect(entries.find(row => row.scheduleId === old.loopId)?.status).toBe('stopped')
  expect(entries.some(row => row.scheduleId === foreign.loopId || row.scheduleId === maintenance.loopId)).toBe(false)
  expect(JSON.stringify(page.arrangements)).not.toContain('Private original prompt')
  expect(viaCli.arrangements).toEqual(page.arrangements)
  const reads = calls.mock.calls.filter(([method]) => method === 'schedule.list')
  expect(reads).toHaveLength(2)
  for (const [, input, context] of reads) { expect(input).toEqual({ target: f.execution() }); expect(context?.caller?.agentSessionId).toBe('primary') }
  expect(inspect).not.toHaveBeenCalled(); expect(f.writes).toEqual([])
  await fact({ kind: 'public-discovery', sdk: page.arrangements, cli: viaCli.arrangements, ownIds: entries.map(row => row.scheduleId), foreignId: foreign.loopId,
    excludedMaintenance: maintenance.loopId, scheduleListCalls: reads.length, inputInspections: inspect.mock.calls.length, writes: f.writes.length })
})

it('a failed arrangement source preserves real readable linked work and its original caller', async () => {
  const f = await fixture(); await linkOriginalWork(f)
  const before = await f.read(), original = f.schedules.call.bind(f.schedules)
  expect(before.observations[0]?.communication).not.toBeNull()
  vi.spyOn(f.schedules, 'call').mockImplementation(async (method, input, context) => {
    if (method === 'schedule.list') throw Error('The original schedule owner is unavailable')
    return await original(method, input as never, context)
  })
  const failed = await f.read()
  expect(failed.links).toEqual(before.links); expect(failed.observations).toEqual(before.observations)
  expect(failed.arrangements).toMatchObject({ sourceStatus: 'unconfirmed', entries: [], hasMore: false, issue: 'The original schedule owner is unavailable' })
})

it('bounded schedule coverage is separate from the empty linked-page cursor', async () => {
  const f = await fixture(); await f.create('bounded-first'); await f.create('bounded-second')
  const page = await f.read(1)
  expect(page.next).toBeNull(); expect(page.arrangements.sourceStatus).toBe('read')
  expect(page.arrangements.entries).toHaveLength(1); expect(page.arrangements.hasMore).toBe(true)
  for (const guide of [MOTE_INPUT_GUIDANCE, MOTE_COORDINATION_ROLE, agentMuxModuleSkill('mote')!]) {
    expect(guide).toContain('arrangements.ownerHostId'); expect(guide).toContain('current-Main schedules only')
  }
})

it('confirmed unbound Main is not source failure and does not query another Session', async () => {
  const f = await fixture()
  await writeFile(f.motePath, serializeMoteQuickMode('', {}))
  const calls = vi.spyOn(f.schedules, 'call'), page = await f.read()
  expect(page.main.current).toBeNull()
  expect(page.arrangements).toMatchObject({ sourceStatus: 'unbound', entries: [], hasMore: false, issue: null })
  expect(calls.mock.calls.filter(([method]) => method === 'schedule.list')).toHaveLength(0)
})

it('a Main change during the original indexed read marks only that source unconfirmed, without reading the new SID', async () => {
  const f = await fixture(); await f.create('held-original-source')
  const original = f.schedules.call.bind(f.schedules); let release!: () => void
  const gate = new Promise<void>(done => { release = done })
  const reads = vi.spyOn(f.schedules, 'call').mockImplementation(async (method, input, context) => {
    const value = await original(method, input, context)
    if (method === 'schedule.list') await gate
    return value
  })
  const pending = f.read()
  try { await vi.waitFor(() => expect(reads.mock.calls.some(([method]) => method === 'schedule.list')).toBe(true))
    await writeFile(f.motePath, serializeMoteQuickMode(await readFile(f.motePath, 'utf8'), { conversation: {
      hostId: 'local', sessionId: 'member', displayWorkspaceId: '__scratch__', groupId: 'group', tabId: 'tab-member', regionId: 'region-member' } }))
  } finally { release() }
  const page = await pending
  expect(page.arrangements.sourceStatus).toBe('unconfirmed'); expect(page.arrangements.entries).toEqual([])
  expect(reads.mock.calls.filter(([method]) => method === 'schedule.list').map(([, input]) => input)).toEqual([{ target: f.execution() }])
})

it('the strict public codec rejects private fields, wrong origin, duplicates and false empty coverage', async () => {
  const f = await fixture(); await f.create('strict-original-source')
  const page = await f.read(1), parse = (arrangements: unknown) => parseMoteDialogueResult('space.mote.dialogue.supervision.read', { ...page, arrangements }, { target: f.target, limit: 1 })
  for (const bad of [
    { ...page.arrangements, ownerHostId: 'another-owner' },
    { ...page.arrangements, entries: [{ ...page.arrangements.entries[0], prompt: 'private hidden body' }] },
    { ...page.arrangements, sourceStatus: ['read'] },
    { ...page.arrangements, entries: [], hasMore: true },
    { ...page.arrangements, entries: [page.arrangements.entries[0], page.arrangements.entries[0]] }
  ]) expect(() => parse(bad)).toThrow()
})

it('nonparticipants cannot use arrangement discovery to cross the original Mote reader boundary', async () => {
  const f = await fixture(); await f.create('private-original-source')
  const stranger = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.root, 'work-discovery.sock') },
    credentials: { agentSessionId: 'stranger', capability: f.capability } }); closes.push(() => stranger.dispose())
  await expect(stranger.call('space.mote.dialogue.supervision.read', { target: f.target })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect((await f.read()).arrangements.entries).toHaveLength(1)
})

it('a routed Main keeps the original resource schedule owner and retained unknown state distinct from its execution Host', async () => {
  const f = await fixture({ mainHostId: 'original-execution-host', restoredUnknown: true })
  const calls = vi.spyOn(f.schedules, 'call'), page = await f.read()
  expect(page.main.current?.hostId).toBe('original-execution-host')
  expect(page.arrangements).toMatchObject({ ownerHostId: 'local', sourceStatus: 'read', coverage: 'current-main-schedules', issue: null })
  expect(page.arrangements.entries).toHaveLength(1)
  expect(page.arrangements.entries[0]).toMatchObject({ status: 'paused', lastOutcome: 'unknown' })
  const listed = calls.mock.calls.filter(([method]) => method === 'schedule.list')
  expect(listed).toHaveLength(1); expect(listed[0]![1]).toEqual({ target: f.execution() })
  expect(listed[0]![2]?.caller).toEqual({ agentSessionId: 'primary', capability: f.capability })
  const original = await f.rpc.call('schedule.inspect', { scheduleId: page.arrangements.entries[0]!.scheduleId })
  expect(original.schedule).not.toBeNull()
  expect(original.schedule!.hostId).toBe('original-execution-host'); expect(original.schedule!.lastOutcome).toBe('unknown')
  expect(f.writes).toEqual([])
  await fact({ kind: 'routed-original', resourceOwner: page.arrangements.ownerHostId, executionHost: original.schedule!.hostId,
    references: page.arrangements.entries, scheduleListCalls: listed.length, writes: 0 })
})

it('an aborted arrangement read is observed immediately while an independent original work source remains held', async () => {
  const f = await fixture(); await linkOriginalWork(f)
  const controller = new AbortController(), unhandled: unknown[] = []
  const noteUnhandled = (reason: unknown) => { unhandled.push(reason) }
  let releaseWork!: () => void, rejectSchedules!: (error: Error) => void
  const heldWork = new Promise<void>(done => { releaseWork = done })
  const heldSchedules = new Promise<never>((_done, reject) => { rejectSchedules = reject })
  const readDispatch = vi.fn(async (_host: string, sourceMessageId: string) => {
    await heldWork; return await f.client.readDispatch({ sourceMessageId })
  })
  process.on('unhandledRejection', noteUnhandled)
  const outcome = f.dialogue.supervision({ target: f.target }, { signal: controller.signal, readDispatch,
    readSchedules: () => heldSchedules, caller: { hostId: 'local', agentSessionId: 'primary', run: { runId: 'run-primary' } } }).catch(error => error)
  try {
    await vi.waitFor(() => expect(readDispatch).toHaveBeenCalledTimes(1))
    controller.abort(new Error('Original read was cancelled'))
    rejectSchedules(new Error('The original arrangement observation was cancelled'))
    await new Promise(done => setTimeout(done, 20))
    releaseWork()
    expect(await outcome).toBe(controller.signal.reason)
    expect(unhandled).toEqual([])
  } finally { releaseWork(); await outcome; process.off('unhandledRejection', noteUnhandled) }
})
