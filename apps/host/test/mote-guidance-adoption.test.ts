import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as core from '@agentmux/core'
import { moteQuickBaseline } from '@agentmux/core/mote-preferences'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { headlessFixture, until } from '../../../packages/core/test/helpers/headless-runtime-fixture.js'
import { createWorkspaceLayout, createWorkbenchViewLayout } from '../../../packages/core/src/spatial-layout.js'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { ScratchTopics } from '../src/mote-resources.js'
import { directoryIdentity, homeZoneId, serializeMoteQuickMode, SCRATCH_WORKSPACE_ID } from '../src/mote-model.js'
import { createHostContent } from '../src/content-owner.js'
import { createHostMoteMainReader } from '../src/mote-dialogue.js'
import { createHostMotePresence } from '../src/mote-presence.js'
import { HostMoteQuickPreferences } from '../src/mote-quick-preferences.js'
import { createGoalRuntime } from '../src/goal-runtime.js'
import { ContinuousProgressLoopManager } from '../src/continuous-progress-loop-manager.js'
import { ContinuousProgressLoopStore } from '../src/continuous-progress-loop-store.js'

const closes: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const person = { actor: { kind: 'user' as const, id: 'private-original-person' } }
async function preserveEvidence(name: string, value: unknown) {
  const directory = process.env.MOTE_GUIDANCE_EVIDENCE_PATH
  if (directory) { await mkdir(directory, { recursive: true }); await writeFile(join(directory, name + '.json'), JSON.stringify(value, null, 2) + '\n') }
}
async function fixture(publicCli = false) {
  const f = await rpcOwnerFixture(['main'], core, () => ({ nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'native-main' } }))
  closes.push(f.close)
  let now = 100000
  const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: join(f.root, 'scratch'), name: 'Private', kind: 'folder' }
  await mkdir(workspace.path)
  const topic = await new ScratchTopics().ensureMote(workspace, 'view:adoption-original')
  const configurationPath = join(f.root, 'configuration.json')
  await writeFile(configurationPath, JSON.stringify({ workspaces: [workspace] }))
  const target = { spaceId: directoryIdentity('local', topic.identityDirectoryPath!), zoneId: homeZoneId(directoryIdentity('local', topic.identityDirectoryPath!)), expectedResource: { hostId: 'local', workspaceId: workspace.id, workspacePath: workspace.path } }
  const reference = { hostId: 'local', sessionId: 'main', displayWorkspaceId: workspace.id, groupId: 'original-group', tabId: 'original-tab', regionId: 'original-region' }
  const motePath = join(topic.physicalDirectoryPath!, 'MOTE.md')
  await writeFile(motePath, serializeMoteQuickMode('---\nversion: 1\ndefaults: {}\n---\nRetain original human notes.\n', { conversation: reference, conversationRevision: 'role-a', presence: { enabled: true, intervalMs: 60000 } }))
  const spatial = new core.AgentMuxSpatialStateStore(join(f.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: { spaces: [{ spaceId: target.spaceId, kind: 'mote', name: 'Private Mote', hostId: 'local', directoryPath: topic.physicalDirectoryPath!, projectId: null, topicId: topic.id }], zones: [{ zoneId: target.zoneId, workspaceId: workspace.id, kind: 'home', hostId: 'local', directoryPath: topic.physicalDirectoryPath!, branch: null }], bindings: [{ spaceId: target.spaceId, zoneId: target.zoneId }], tabs: [], regions: [], layouts: {}, tabLayouts: {}, resources: {} } })
  const files = createHostContent({ configurationPath, spatial }).files!
  const main = createHostMoteMainReader({ configurationPath, spatial, files })
  const runtime = createGoalRuntime({ clients: f.coreClients, checkIn: async () => ({ known: false, reason: 'Unused' }) })
  const store = new ContinuousProgressLoopStore(join(f.root, 'loops.json'))
  const oldSystem = 'Original private platform context. Preserve bytes: 中文\n<custom>$(literal)</custom>'
  const writer = vi.fn(async (loop: core.ContinuousProgressLoop, active: boolean, context?: core.AgentMuxRpcCallContext) => {
    if (!loop.currentDefinition && !await f.client.readAgentFuturePromptIntent(loop.agentSessionId, loop.futureIntentId!)) {
      await f.client.saveAgentFuturePromptIntent({ agentSessionId: loop.agentSessionId, expectedRun: f.client.agentSession(loop.agentSessionId).run, intentId: loop.futureIntentId!, operationId: loop.creationOperationId!, ...(loop.managedSource ? { continuitySource: loop.managedSource } : {}), prompt: loop.prompt, agentMuxNote: oldSystem, active })
    } else await runtime.saveFutureIntent(loop, active, context)
  })
  const sent = vi.fn(async () => 'sent' as const)
  const observe = vi.fn(async (_loop: core.ContinuousProgressLoop, _tickId: string, _now: number, _signal: AbortSignal): Promise<core.ContinuousProgressObservation> => { throw Error('No due input authorized by this fixture') })
  const manager = new ContinuousProgressLoopManager(store, sent, () => now, observe, { saveFutureIntent: writer, inspectFutureIntent: runtime.inspectFutureIntent })
  closes.push(() => manager.stop())
  const presence = createHostMotePresence({ configurationPath, spatial, files, main, schedules: manager, clients: f.coreClients })
  closes.push(() => presence.dispose())
  // Existing historical custom message: creation uses the real Core immutable writer.
  const snapshot = await main.readCurrentMoteMain(target)
  const { motePresenceSourceId } = await import('../src/mote-presence.js')
  const original = (await manager.call('schedule.create', { target: { hostId: 'local', agentSessionId: 'main', providerId: 'codex', workspacePath: f.root }, everyMs: 60000, prompt: 'Original custom heartbeat user content.', managedSource: { sourceId: motePresenceSourceId(snapshot.identity!), revision: 'role-a' }, operationId: 'original-create' })).schedule
  const quick = new HostMoteQuickPreferences({ files, main, catalog: async () => core.spatialCatalog((await spatial.read())!.graph), executors: async () => [], maintenance: presence.read, adoptGuidance: presence.adoptGuidance })
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'adopt.sock'), coreClients: f.coreClients, moteQuickPreferences: quick, schedules: manager })
  if (publicCli) { await server.start(); closes.push(() => server.stop()) }
  async function cli(path: string[], input: unknown, agent = false) {
    return await new Promise<any>((yes, no) => {
      const child = spawn(process.execPath, ['--experimental-transform-types', '--import', resolve(import.meta.dirname, 'mote-guidance-adoption-node-loader.mjs'), resolve(import.meta.dirname, '../../../packages/core/src/agentmux.ts'), '--endpoint', 'unix:' + server.path, ...path, path[0] === 'schedule' ? '--data' : '--input', '-'], { env: { ...objectCliEnvironment(f.root), ...(agent ? { AGENTMUX_AGENT_SESSION_ID: 'main', AGENTMUX_AGENT_CAPABILITY: f.capability } : {}) }, stdio: ['pipe', 'pipe', 'pipe'] })
      let out = '', err = ''; child.stdout.on('data', value => out += value); child.stderr.on('data', value => err += value)
      child.once('error', no); child.once('close', code => code === 0 ? yes(JSON.parse(out).result) : no(Error(err))); child.stdin.end(JSON.stringify(input))
    })
  }
  async function request(operationId = 'adopt-original') {
    const read = await quick.read({ kind: 'quick', target }), loop = manager.inspectLoop(original.loopId)!
    return { kind: 'quick' as const, target, operationId, baseline: moteQuickBaseline(read)!, values: read.defaults!, action: { kind: 'adopt-current-guidance' as const, expectedSchedule: { loopId: loop.loopId, revision: loop.revision! }, expectedMain: { roleRevision: 'role-a', reference }, expectedDefinition: { intentId: loop.futureIntentId!, operationId: loop.currentDefinition?.operationId ?? loop.creationOperationId! }, guidanceRevision: read.maintenance!.guidance!.availableRevision } }
  }
  return { ...f, target, reference, motePath, main, files, manager, store, quick, presence, writer, runtime, cli, original, oldSystem, request, sent, observe, setNow: (value: number) => now = value }
}

it('actual preferences CLI adopts one new immutable definition in the same arrangement without a display occurrence or File write', async () => {
  const f = await fixture(true), input = await f.request()
  const before = await readFile(f.motePath, 'utf8'), old = await f.client.readAgentFuturePromptIntent('main', f.original.futureIntentId!)
  const saved = await f.cli(['space', 'mote', 'preferences', 'save'], input)
  expect(saved).toMatchObject({ status: 'unchanged', maintenanceAdoption: { operationId: input.operationId, loopId: f.original.loopId, state: 'adopted', issue: null } })
  const loop = (await f.cli(['schedule', 'inspect'], { operationId: input.operationId })).schedule
  expect(loop).toMatchObject({ loopId: f.original.loopId, agentSessionId: 'main', creationOperationId: 'original-create', status: 'active', prompt: f.original.prompt, revision: f.original.revision! + 1, currentDefinition: { operationId: saved.maintenanceAdoption.newDefinition.operationId, baseIntentId: f.original.futureIntentId } })
  expect(loop.futureIntentId).not.toBe(f.original.futureIntentId)
  expect(await f.client.readAgentFuturePromptIntent('main', f.original.futureIntentId!)).toEqual(old)
  const adopted = await f.client.readAgentFuturePromptIntent('main', loop.futureIntentId)
  expect(adopted).toMatchObject({ active: true, operationId: loop.currentDefinition.operationId, message: { userContent: f.original.prompt, systemContext: expect.stringContaining(f.oldSystem) } })
  expect(adopted!.message.systemContext).toContain('Ideas')
  expect(await readFile(f.motePath, 'utf8')).toBe(before)
  expect((await f.cli(['space', 'mote', 'preferences', 'save'], input)).maintenanceAdoption).toEqual(saved.maintenanceAdoption)
  expect(f.sent).not.toHaveBeenCalled(); expect(f.rawInput).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('person/device adoption cannot be borrowed by an Agent, missing direct actor, settings edits, stale source or complete Main tuple drift', async () => {
  const f = await fixture(true), input = await f.request()
  await expect(f.cli(['space', 'mote', 'preferences', 'save'], input, true)).rejects.toThrow(/permission|person|device|authenticated/i)
  expect(await f.quick.save(input)).toMatchObject({ status: 'refused-before-write' })
  expect(await f.quick.save(input, { actor: { kind: 'agent', id: 'main' } })).toMatchObject({ status: 'refused-before-write' })
  expect(await f.quick.save({ ...input, values: { ...input.values, executorId: 'changed' } }, person)).toMatchObject({ status: 'refused-before-write' })
  expect(await f.quick.save({ ...input, action: { ...input.action, expectedMain: { ...input.action.expectedMain, reference: { ...f.reference, regionId: 'foreign-region' } } } }, person)).toMatchObject({ status: 'refused-before-write' })
  expect(await f.quick.save({ ...input, action: { ...input.action, expectedDefinition: { ...input.action.expectedDefinition, intentId: 'foreign-intent' } } }, person)).toMatchObject({ status: 'refused-before-write' })
  expect(f.manager.inspectLoop(f.original.loopId)).toEqual(f.original)
})

it('paused state, its original episode and an unknown claimed input are retained byte-for-byte during preparation', async () => {
  const f = await fixture()
  const paused = (await f.manager.call('schedule.pause', { scheduleId: f.original.loopId, expectedRevision: f.original.revision!, operationId: 'original-pause' })).schedule
  const pending = { id: 'old-unknown-input', operationId: 'old-unknown-operation', inputByte: 7, prompt: 'Frozen old claim', agentMuxNote: 'Frozen old system', futureIntent: { intentId: f.original.futureIntentId!, occurrenceAt: 80000 } }
  const frozen = { ...paused, pendingCompletion: pending, lastTickId: pending.operationId, lastOutcome: 'unknown' as const }
  Reflect.get(f.manager, 'scheduler').replace(f.original.loopId, frozen)
  await f.store.save([frozen])
  const input = await f.request(), result = await f.quick.save(input, person)
  expect(result).toMatchObject({ status: 'unchanged', maintenanceAdoption: { state: 'prepared', issue: expect.any(String) } })
  const current = f.manager.inspectLoop(f.original.loopId)!
  expect(current).toMatchObject({ status: 'paused', pause: paused.pause, revision: paused.revision, futureIntentId: f.original.futureIntentId, pendingCompletion: pending, lastTickId: frozen.lastTickId, lastOutcome: 'unknown' })
  const prepared = await f.client.readAgentFuturePromptIntent('main', result.maintenanceAdoption!.newDefinition.intentId)
  expect(prepared?.active).toBe(false)
  expect(f.sent).not.toHaveBeenCalled()
})

it('legacy unknown without a pending input adopts only a strictly future occurrence and never resumes a paused arrangement', async () => {
  const f = await fixture()
  const paused = (await f.manager.call('schedule.pause', { scheduleId: f.original.loopId, expectedRevision: 1, operationId: 'keep-paused' })).schedule
  Reflect.get(f.manager, 'scheduler').replace(paused.loopId, { ...paused, lastOutcome: 'unknown', lastTickId: 'retained-legacy-unknown', nextCheckAt: 50000 })
  f.setNow(250000)
  const result = await f.quick.save(await f.request(), person), current = f.manager.inspectLoop(paused.loopId)!
  expect(result.maintenanceAdoption?.state).toBe('adopted')
  expect(current).toMatchObject({ status: 'paused', pause: paused.pause, lastOutcome: 'unknown', lastTickId: 'retained-legacy-unknown' })
  expect(current.nextCheckAt).toBeGreaterThan(250000)
  expect((await f.client.readAgentFuturePromptIntent('main', current.futureIntentId!))?.active).toBe(false)
  expect(f.sent).not.toHaveBeenCalled()
})

it.each(['host-prepare', 'core-prepare', 'host-publish', 'core-activate'] as const)('a lost %s ACK reconciles the same frozen operation and definition across owner reload', async stage => {
  const f = await fixture(), input = await f.request()
  let dropped = false
  const save = f.store.save.bind(f.store), write = f.writer.getMockImplementation()!
  vi.spyOn(f.store, 'save').mockImplementation(async loops => {
    await save(loops)
    const receipt = loops[0]?.guidanceAdoptions?.find(value => value.operationId === input.operationId)
    if (!dropped && receipt && (stage === 'host-prepare' && receipt.state === 'prepared' || stage === 'host-publish' && receipt.publishedAt !== undefined)) {
      dropped = true; throw Error('Private fixture lost Host ACK after the original durable write')
    }
  })
  f.writer.mockImplementation(async (loop, active, context) => {
    await write(loop, active, context)
    if (!dropped && loop.currentDefinition && (stage === 'core-prepare' && !active || stage === 'core-activate' && active)) {
      dropped = true; throw Error('Private fixture lost Core ACK after the original immutable write')
    }
  })
  const result = await f.quick.save(input, person)
  expect(dropped).toBe(true)
  expect(result).toMatchObject({ status: 'unchanged', maintenanceAdoption: { state: 'unconfirmed', operationId: input.operationId } })
  const retained = result.maintenanceAdoption!, before = f.manager.inspectLoop(f.original.loopId)!
  // Reconstruct the real Host owner from its original persisted loop file.
  await f.manager.stop(); f.presence.dispose()
  const resumed = new ContinuousProgressLoopManager(f.store, f.sent, () => 100000, async () => { throw Error('No automatic input') }, { saveFutureIntent: f.writer, inspectFutureIntent: f.runtime.inspectFutureIntent })
  closes.push(() => resumed.stop()); await resumed.start()
  const current = resumed.inspectLoop(f.original.loopId)!
  expect(current.guidanceAdoptions![0]!.newDefinition).toEqual(retained.newDefinition)
  expect(current.creationOperationId).toBe(f.original.creationOperationId)
  expect(current.pendingCompletion).toEqual(before.pendingCompletion)
  const actor = person.actor
  const reconciled = await resumed.adoptGuidance({ loopId: current.loopId, expectedRevision: input.action.expectedSchedule.revision, expectedDefinition: input.action.expectedDefinition, operationId: input.operationId, requestDigest: retained.requestDigest, actor, guidanceRevision: retained.newDefinition.guidanceRevision, guidance: 'A newer application text must not replace this original frozen request' }, async () => { await f.main.assertCurrent(await f.main.readCurrentMoteMain(f.target)) }, { principal: actor })
  expect(reconciled).toMatchObject({ state: 'adopted', newDefinition: retained.newDefinition, guidance: retained.guidance })
  expect(resumed.inspectLoop(current.loopId)?.guidanceAdoptions).toHaveLength(1)
  expect(f.sent).not.toHaveBeenCalled(); expect(f.rawInput).not.toHaveBeenCalled()
})

it.each(['pause', 'cancel', 'role-a-b-a'] as const)('a late activation ACK cannot undo a later %s', async change => {
  const f = await fixture(), input = await f.request()
  let entered!: () => void, release!: () => void
  const reached = new Promise<void>(yes => entered = yes), held = new Promise<void>(yes => release = yes)
  const write = f.writer.getMockImplementation()!
  let holding = false
  f.writer.mockImplementation(async (loop, active, context) => {
    await write(loop, active, context)
    if (loop.currentDefinition && active && !holding) { holding = true; entered(); await held }
  })
  const saving = f.quick.save(input, person)
  await reached
  if (change === 'pause') await f.manager.pause(f.original.loopId)
  else if (change === 'cancel') await f.manager.stopLoop(f.original.loopId)
  else {
    const source = await readFile(f.motePath, 'utf8')
    await writeFile(f.motePath, serializeMoteQuickMode(source, { ...input.values, conversationRevision: 'role-b', conversation: { ...f.reference, sessionId: 'foreign-main' } }))
    await writeFile(f.motePath, serializeMoteQuickMode(await readFile(f.motePath, 'utf8'), { ...input.values, conversationRevision: 'role-a-again' }))
  }
  release()
  const result = await saving, current = f.manager.inspectLoop(f.original.loopId)!
  expect(result.maintenanceAdoption).toMatchObject({ state: 'unconfirmed', issue: expect.any(String) })
  expect((await f.client.readAgentFuturePromptIntent('main', current.futureIntentId!))?.active).toBe(false)
  if (change !== 'role-a-b-a') expect(current.status).toBe(change === 'pause' ? 'paused' : 'stopped')
  expect(f.sent).not.toHaveBeenCalled()
})

it('a second guide uses the typed original base rather than accumulating earlier app guidance', async () => {
  const f = await fixture(), first = await f.quick.save(await f.request(), person)
  expect(first.maintenanceAdoption?.state).toBe('adopted')
  const current = f.manager.inspectLoop(f.original.loopId)!, guidance = 'Version B bounded work-cycle guidance.'
  const saved = await f.manager.adoptGuidance({ loopId: current.loopId, expectedRevision: current.revision!, expectedDefinition: { intentId: current.futureIntentId!, operationId: current.currentDefinition!.operationId }, operationId: 'explicit-version-b', requestDigest: createHash('sha256').update('version-b-original-request').digest('hex'), actor: person.actor, guidanceRevision: 'guide-b', guidance }, async () => {}, { principal: person.actor })
  expect(saved).toMatchObject({ state: 'adopted', newDefinition: { baseIntentId: f.original.futureIntentId, guidanceRevision: 'guide-b' } })
  const original = await f.client.readAgentFuturePromptIntent('main', f.original.futureIntentId!), upgraded = await f.client.readAgentFuturePromptIntent('main', saved.newDefinition.intentId)
  expect(upgraded!.message.userContent).toBe(original!.message.userContent)
  expect(upgraded!.message.systemContext).toBe(original!.message.systemContext + '\n\n' + guidance)
  expect(upgraded!.message.systemContext).not.toContain(first.maintenanceAdoption!.guidance)
  expect(f.rawInput).not.toHaveBeenCalled()
})

it('a fresh explicit request can retire an inactive unpublished preparation after ordinary MOTE edits', async () => {
  const f = await fixture(), input = await f.request()
  const write = f.writer.getMockImplementation()!
  let dropped = false
  f.writer.mockImplementation(async (loop, active, context) => {
    await write(loop, active, context)
    if (loop.currentDefinition && !active && !dropped) { dropped = true; throw Error('Lost Core prepare receipt') }
  })
  const old = (await f.quick.save(input, person)).maintenanceAdoption!
  expect(old.state).toBe('unconfirmed'); expect(old.publishedAt).toBeUndefined()
  await writeFile(f.motePath, (await readFile(f.motePath, 'utf8')) + '\nA later human note must be retained.\n')
  const fresh = await f.request('explicit-fresh-adoption'), result = await f.quick.save(fresh, person)
  expect(result.maintenanceAdoption?.state).toBe('adopted')
  const records = f.manager.inspectLoop(f.original.loopId)!.guidanceAdoptions!
  const { loopId: _, ...originalRecord } = old
  expect(records).toHaveLength(2)
  expect(records[0]).toEqual({ ...originalRecord, state: 'refused', issue: expect.any(String) })
  expect(records[1]).toMatchObject({ operationId: fresh.operationId, state: 'adopted' })
  expect((await f.client.readAgentFuturePromptIntent('main', old.newDefinition.intentId))?.active).toBe(false)
  expect(await readFile(f.motePath, 'utf8')).toContain('A later human note must be retained.')
  expect(f.sent).not.toHaveBeenCalled()
})

it('adoption fences an already claimed old-definition preparation before its actual delivery callback', async () => {
  const f = await fixture()
  await f.manager.check(100000)
  let entered!: () => void, release!: () => void, observations = 0
  const reached = new Promise<void>(yes => entered = yes), held = new Promise<void>(yes => release = yes)
  f.observe.mockImplementation(async (loop, tickId, now) => {
    const session = f.client.agentSession('main')
    if (++observations === 2) { entered(); await held }
    const intent = await f.client.readAgentFuturePromptIntent('main', loop.futureIntentId!)
    if (!intent) throw Error('The original fixture intent is absent')
    return { session: { ...session, semanticStatus: { state: 'done', source: 'native-hook', observedAt: now, stateEnteredAt: now }, futurePromptIntents: { [loop.futureIntentId!]: intent } }, observation: { process: 'running', semantic: 'idle', readiness: 'ready', stale: false, source: 'native-hook', observedAt: now }, inputByte: 0, tickId, now }
  })
  f.setNow(160000)
  const checking = f.manager.check(160000)
  await reached
  const write = f.writer.getMockImplementation()!
  f.writer.mockImplementation(async (loop, active, context) => {
    await write(loop, active, context)
    // Let a wrongly unfenced original observation finish. Correct cancellation
    // settles that exact check before this callback can cross the input boundary.
    if (loop.currentDefinition && !active) setTimeout(release, 20)
  })
  const result = await f.quick.save(await f.request(), person)
  release(); await checking
  expect(result.maintenanceAdoption?.state).toBe('adopted')
  expect(f.sent).not.toHaveBeenCalled()
  expect(f.manager.inspectLoop(f.original.loopId)?.pendingCompletion).toBeUndefined()
})

async function publishedUnknown(f: Awaited<ReturnType<typeof fixture>>, beforeActivation = false) {
  const input = await f.request(), write = f.writer.getMockImplementation()!
  let lost = false
  f.writer.mockImplementation(async (loop, active, context) => {
    if (beforeActivation && loop.currentDefinition && active && !lost) { lost = true; throw Error('Core activation was not confirmed') }
    await write(loop, active, context)
    if (!beforeActivation && loop.currentDefinition && active && !lost) { lost = true; throw Error('Core activation committed; its ACK was lost') }
  })
  const saved = await f.quick.save(input, person)
  expect(saved.maintenanceAdoption).toMatchObject({ state: 'unconfirmed', publishedAt: expect.any(Number) })
  return { input, saved }
}

it('a published original operation remains reconcilable after notes-only edits without borrowing a new baseline or changing the draft', async () => {
  const f = await fixture(), { input, saved } = await publishedUnknown(f)
  await writeFile(f.motePath, (await readFile(f.motePath, 'utf8')) + '\nA later human draft note.\n')
  const updated = await readFile(f.motePath, 'utf8')
  const freshNew = await f.quick.save(await f.request('new-op-must-not-hide-old-unknown'), person)
  expect(freshNew.status).toBe('refused-before-write')
  const result = await f.quick.save(input, person)
  expect(result).toMatchObject({ status: 'unchanged', source: input.baseline, maintenanceAdoption: { state: 'adopted', newDefinition: saved.maintenanceAdoption!.newDefinition } })
  expect(await readFile(f.motePath, 'utf8')).toBe(updated)
  expect(f.sent).not.toHaveBeenCalled()
})

it.each(['update', 'pause', 'pause-resume'] as const)('a later explicit %s can be read back to settle the original published operation without old-authority activation', async action => {
  const f = await fixture(), { input } = await publishedUnknown(f)
  let loop = f.manager.inspectLoop(f.original.loopId)!
  if (action === 'update') await f.manager.call('schedule.update', { scheduleId: loop.loopId, expectedRevision: loop.revision!, everyMs: 120000, operationId: 'later-interval' })
  else {
    loop = (await f.manager.call('schedule.pause', { scheduleId: loop.loopId, expectedRevision: loop.revision!, operationId: 'later-pause' })).schedule
    if (action === 'pause-resume') await f.manager.call('schedule.resume', { scheduleId: loop.loopId, expectedRevision: loop.revision!, operationId: 'later-resume' })
  }
  const originalControl = f.manager.inspectLoop(loop.loopId)!, calls = f.writer.mock.calls.length
  expect((await f.quick.save(input, person)).maintenanceAdoption?.state).toBe('adopted')
  expect(f.writer.mock.calls).toHaveLength(calls)
  expect(f.manager.inspectLoop(loop.loopId)).toMatchObject({ status: originalControl.status, revision: originalControl.revision })
  expect(f.manager.inspectLoop(loop.loopId)?.pause).toEqual(originalControl.pause)
  expect(f.sent).not.toHaveBeenCalled()
})

it('an unmatched later Core activation stays unknown until the exact explicit control converges it', async () => {
  const f = await fixture(), { input } = await publishedUnknown(f, true)
  let loop = f.manager.inspectLoop(f.original.loopId)!
  loop = (await f.manager.call('schedule.update', { scheduleId: loop.loopId, expectedRevision: loop.revision!, everyMs: 120000, operationId: 'later-interval' })).schedule
  const calls = f.writer.mock.calls.length
  expect((await f.quick.save(input, person)).maintenanceAdoption?.state).toBe('unconfirmed')
  expect(f.writer.mock.calls).toHaveLength(calls)
  await f.manager.call('schedule.resume', { scheduleId: loop.loopId, expectedRevision: loop.revision!, operationId: 'explicit-core-convergence' })
  expect((await f.quick.save(input, person)).maintenanceAdoption?.state).toBe('adopted')
  expect(f.sent).not.toHaveBeenCalled()
})

it('continuous Host persistence failure after publication retains the exact unknown adoption receipt and operation', async () => {
  const f = await fixture(), input = await f.request(), save = f.store.save.bind(f.store)
  const broken = vi.spyOn(f.store, 'save').mockImplementation(async loops => {
    if (loops.some(loop => loop.guidanceAdoptions?.some(value => value.publishedAt !== undefined))) throw Error('Persistent private disk failure after publish')
    await save(loops)
  })
  const first = await f.quick.save(input, person), repeat = await f.quick.save(input, person)
  expect(first).toMatchObject({ status: 'unchanged', maintenanceAdoption: { operationId: input.operationId, state: 'unconfirmed' } })
  expect(repeat).toMatchObject({ status: 'unchanged', maintenanceAdoption: { operationId: input.operationId, state: 'unconfirmed', newDefinition: first.maintenanceAdoption!.newDefinition } })
  expect((await f.client.readAgentFuturePromptIntent('main', first.maintenanceAdoption!.newDefinition.intentId))?.active).toBe(false)
  broken.mockRestore()
  expect((await f.quick.save(input, person)).maintenanceAdoption?.state).toBe('adopted')
  const noWrite = vi.spyOn(f.store, 'save').mockRejectedValue(Error('A read must not rewrite the original final receipt'))
  expect((await f.quick.save(input, person)).maintenanceAdoption?.state).toBe('adopted')
  expect(noWrite).not.toHaveBeenCalled(); noWrite.mockRestore()
  expect(f.sent).not.toHaveBeenCalled()
})

it('an unexpected lost adoption return never masquerades as a pre-write refusal', async () => {
  const f = await fixture(), input = await f.request()
  const proxy = new HostMoteQuickPreferences({ files: f.files, main: f.main, catalog: async () => null, executors: async () => [], adoptGuidance: async (...args) => { await f.presence.adoptGuidance(...args); throw Error('Lost original owner return after its real adoption') } })
  expect(await proxy.save(input, person)).toMatchObject({ status: 'unconfirmed', operationId: input.operationId })
  expect(f.manager.inspectLoop(f.original.loopId)?.guidanceAdoptions?.[0]?.state).toBe('adopted')
  expect(f.sent).not.toHaveBeenCalled()
})

it.each(['host-prepare', 'core-prepare', 'host-publish', 'core-activate'] as const)('two real OS owners retain and reconcile the %s phase without input or identity replacement', async stage => {
  const f = await fixture(), input = await f.request(), original = f.client.agentSession('main')
  const oldIntent = await f.client.readAgentFuturePromptIntent('main', f.original.futureIntentId!)
  f.presence.dispose(); await f.manager.stop()
  async function owner(pass: number) {
    const request = join(f.root, 'owner-' + pass + '.json'), output = join(f.root, 'result-' + pass + '.json')
    await writeFile(request, JSON.stringify({ root: f.root, input, actor: person.actor, stage: pass === 1 ? stage : null, output }))
    await new Promise<void>((yes, no) => {
      const child = spawn(process.execPath, ['--experimental-transform-types', '--import', resolve(import.meta.dirname, 'mote-guidance-adoption-node-loader.mjs'), resolve(import.meta.dirname, 'fixtures/mote-guidance-adoption-owner.mjs'), request], { env: objectCliEnvironment(f.root), stdio: ['ignore', 'pipe', 'pipe'] })
      let err = ''; child.stderr.on('data', value => err += value); child.once('error', no); child.once('close', code => code === 0 ? yes() : no(Error(err)))
    })
    return JSON.parse(await readFile(output, 'utf8'))
  }
  const a = await owner(1), b = await owner(2)
  await preserveEvidence('os-' + stage, { root: f.root, a, b })
  expect(a.pid).not.toBe(b.pid)
  expect(a.dropped).toBe(true)
  expect(a.result).toMatchObject({ status: 'unchanged', maintenanceAdoption: { state: 'unconfirmed' } })
  expect(b.result).toMatchObject({ status: 'unchanged', maintenanceAdoption: { state: 'adopted', newDefinition: a.result.maintenanceAdoption.newDefinition, guidance: a.result.maintenanceAdoption.guidance } })
  expect(b.loop).toMatchObject({ loopId: f.original.loopId, creationOperationId: f.original.creationOperationId, agentSessionId: 'main' })
  expect(b.session).toEqual({ agentSessionId: original.agentSessionId, run: original.run, nativeHandle: original.nativeHandle })
  expect(b.oldIntent).toEqual(oldIntent)
  expect(b.newIntent).toMatchObject({ active: true, operationId: a.result.maintenanceAdoption.newDefinition.operationId })
  expect(f.rawInput).not.toHaveBeenCalled()
}, 60000)

it('the full booted Host wires the original CLI adoption through its maintenance owner and retains it after a real process restart', async () => {
  const loader = resolve(import.meta.dirname, 'mote-guidance-adoption-node-loader.mjs'), previous = process.env.AGENTMUX_TEST_OWNER_ENTRY
  process.env.AGENTMUX_TEST_OWNER_ENTRY = resolve(import.meta.dirname, 'fixtures/mobile-web-host.mjs')
  let f: Awaited<ReturnType<typeof headlessFixture>>
  try { f = await headlessFixture({ ownerNodeArgs: ['--experimental-transform-types', '--import', loader] }) }
  finally { if (previous === undefined) delete process.env.AGENTMUX_TEST_OWNER_ENTRY; else process.env.AGENTMUX_TEST_OWNER_ENTRY = previous }
  let sid: string | undefined
  closes.push(async () => { try { if (sid) { const client = await f.client(); const current = await client.statusAgent(sid); if (current.run.state === 'running') await client.stopAgent(sid, current.session.run) } } finally { await f.cleanup() } })
  const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: join(f.root, 'scratch'), name: 'Private original Mote', kind: 'folder' }
  await mkdir(workspace.path)
  const topic = await new ScratchTopics().ensureMote(workspace, 'view:full-host-guidance')
  const configurationPath = join(f.env.AGENTMUX_STATE_DIRECTORY!, 'original-configuration.json')
  await writeFile(configurationPath, JSON.stringify({ workspaces: [workspace], executors: { codex: { providerId: 'codex', label: 'Private deterministic executable', command: process.execPath, args: [resolve(import.meta.dirname, '../../../packages/core/test/fixtures/fake-codex-cli.mjs')], env: { CODEX_HOME: join(f.root, 'home'), AGENTMUX_FAKE_READY_MODE: 'before', AGENTMUX_FAKE_NATIVE_RECORD: '1', AGENTMUX_FAKE_NATIVE_PRESERVE: '1', AGENTMUX_FAKE_NATIVE_RECORD_DIRECTORY: join(f.root, 'native'), AGENTMUX_FAKE_NATIVE_CONTEXT: 'Retained private decisions' }, injectAgentMuxGuide: false } }, appearance: {} }))
  await writeFile(join(topic.physicalDirectoryPath!, 'MOTE.md'), '---\nversion: 1\ndefaults: {}\n---\nOriginal user notes.\n')
  const spaceId = directoryIdentity('local', topic.identityDirectoryPath!), zoneId = homeZoneId(spaceId), tabId = 'private-main-tab', regionId = 'private-main-region', groupId = 'private-main-group'
  const target = { spaceId, zoneId, expectedResource: { hostId: 'local', workspaceId: workspace.id, workspacePath: workspace.path } }
  const spatial = new core.AgentMuxSpatialStateStore(join(f.env.AGENTMUX_STATE_DIRECTORY!, 'spatial-state.json')), before = await spatial.read()
  await spatial.commit({ expectedRevision: before?.revision ?? 0, graph: { spaces: [{ spaceId, kind: 'mote', name: 'Private Mote', hostId: 'local', directoryPath: topic.physicalDirectoryPath!, projectId: null, topicId: topic.id }], zones: [{ zoneId, workspaceId: workspace.id, kind: 'home', hostId: 'local', directoryPath: topic.physicalDirectoryPath!, branch: null }], bindings: [{ spaceId, zoneId }], tabs: [{ tabId, zoneId, workspaceId: workspace.id, name: 'Main', regionIds: [regionId] }], regions: [{ tabId, regionId, kind: 'launcher', agentSessionId: null, runId: null, execution: null }], layouts: { [workspace.id]: createWorkspaceLayout(groupId, [tabId]) }, tabLayouts: { [tabId]: createWorkbenchViewLayout(regionId) }, resources: {} } })
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.socketPath } }); closes.push(() => rpc.dispose())
  const opened = await rpc.call('agent.open', { operationId: 'full-host-original-main', content: { kind: 'new-agent', executorId: 'codex' }, destination: { spaceId, zoneId, tabId, regionId }, focus: false })
  sid = opened.agent!.agentSessionId
  const client = await f.client(), original = await until(() => client.statusAgent(sid!), value => Boolean(value.session.nativeHandle) && value.observation.readiness === 'ready', 'private deterministic original Main readiness')
  let read = await rpc.call('space.mote.preferences.read', { kind: 'quick', target })
  const reference = { hostId: 'local', sessionId: sid, displayWorkspaceId: workspace.id, groupId, tabId, regionId }
  const bound = await rpc.call('space.mote.preferences.save', { kind: 'quick', target, operationId: 'full-host-bind-original-main', baseline: moteQuickBaseline(read as any)!, values: { ...(read as any).defaults, conversation: reference }, destination: { kind: 'occurrence', displayWorkspaceId: workspace.id, groupId, tabId, regionId } })
  expect(bound.status).toBe('saved')
  read = await until(() => rpc.call('space.mote.preferences.read', { kind: 'quick', target }), value => value.kind === 'quick' && value.maintenance?.status === 'active', 'actual Host original maintenance')
  if (read.kind !== 'quick') throw Error('Wrong preferences owner')
  const loop = read.maintenance!.schedule!, input = { kind: 'quick', target, operationId: 'full-host-explicit-adopt', baseline: moteQuickBaseline(read)!, values: read.defaults!, action: { kind: 'adopt-current-guidance', expectedSchedule: { loopId: loop.loopId, revision: loop.revision }, expectedMain: { roleRevision: read.defaults!.conversationRevision!, reference }, expectedDefinition: { intentId: loop.futureIntentId, operationId: loop.creationOperationId }, guidanceRevision: read.maintenance!.guidance!.availableRevision } }
  const saved = await new Promise<any>((yes, no) => {
    const child = spawn(process.execPath, ['--experimental-transform-types', '--import', loader, resolve(import.meta.dirname, '../../../packages/core/src/agentmux.ts'), '--endpoint', 'unix:' + f.socketPath, 'space', 'mote', 'preferences', 'save', '--input', '-'], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = ''; child.stdout.on('data', value => out += value); child.stderr.on('data', value => err += value); child.once('error', no); child.once('close', code => code === 0 ? yes(JSON.parse(out).result) : no(Error(err))); child.stdin.end(JSON.stringify(input))
  })
  expect(saved).toMatchObject({ status: 'unchanged', maintenanceAdoption: { state: 'adopted', loopId: loop.loopId } })
  const oldPid = f.ownerProcess.pid
  await f.restart()
  expect(f.ownerProcess.pid).not.toBe(oldPid)
  const next = await f.client(), restored = await next.statusAgent(sid)
  expect(restored.session.run).toEqual(original.session.run); expect(restored.session.nativeHandle).toEqual(original.session.nativeHandle)
  expect(restored.run.acceptedInputBytes).toBe(original.run.acceptedInputBytes)
  const rpc2 = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.socketPath } }); closes.push(() => rpc2.dispose())
  const receipt = await rpc2.call('schedule.inspect', { operationId: input.operationId })
  expect(receipt.schedule).toMatchObject({ loopId: loop.loopId, agentSessionId: sid, status: 'active', currentDefinition: saved.maintenanceAdoption.newDefinition })
  const layout = await spatial.read()
  expect(layout!.graph.regions.find(value => value.regionId === regionId)?.agentSessionId).toBe(sid)
  await preserveEvidence('full-host', { root: f.root, oldPid, newPid: f.ownerProcess.pid, session: { agentSessionId: sid, originalRun: original.session.run, restoredRun: restored.session.run, originalNative: original.session.nativeHandle, restoredNative: restored.session.nativeHandle, originalInputBytes: original.run.acceptedInputBytes, restoredInputBytes: restored.run.acceptedInputBytes }, adoption: saved.maintenanceAdoption, schedule: receipt.schedule, region: layout!.graph.regions.find(value => value.regionId === regionId) })
}, 90000)
