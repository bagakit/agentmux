import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, rm, mkdir, open, readFile, readdir, rename, symlink, writeFile, unlink, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import * as core from '@agentmux/core'
import { FilePathMutations } from '../src/file-path-mutations.js'
import { NameChangeAudit } from '../src/name-change-audit.js'
import { agent, cleanup, fixture, helper, hostFixture, operationRecord } from './helpers/file-path-fixture.js'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID, scratchTopicDirectoryName } from '../src/mote-topic-model.js'
import { OrdinaryWorkspaceFiles } from '../src/ordinary-files.js'
import { cleanupExecutableNativeFixtures, executableNativeFixture, until } from '../../../packages/core/test/helpers/executable-native-fixture.js'
import { CapsuleRunManager } from '../../../packages/core/src/capsule-run-manager.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { publishNotebookFiles } from '../../../packages/core/src/notebook-files.js'
import { performance } from 'node:perf_hooks'
import { noteHistoryRevision } from '@agentmux/core/note-history'
import { applyNotebookChange, applyNotebookFileRelocations, emptyNotebookState, parseNotebookFileRelocationPlan } from '@agentmux/core/notebook-store'
import type { FileMoveParams } from '@agentmux/core/files'

const facts: unknown[] = []
afterAll(async () => { if (process.env.AGENTMUX_FILE_PATH_MOVE_EVIDENCE) await writeFile(process.env.AGENTMUX_FILE_PATH_MOVE_EVIDENCE, JSON.stringify({ schema: 'agentmux.file-move-proof.v1', platform: process.platform, facts }, null, 2) + '\n') })

beforeAll(async () => { await promisify(execFile)(process.execPath, [resolve('apps/host/scripts/build-workspace-move-helper.mjs')]) })
afterEach(async () => { await cleanupExecutableNativeFixtures(); for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

async function moveFixture(options: NonNullable<Parameters<typeof fixture>[0]> = {}) {
  const f = await fixture(options), spatial = new core.AgentMuxSpatialStateStore()
  await spatial.commit({ expectedRevision: 0, graph: { spaces: [], zones: [], bindings: [], tabs: [], regions: [], layouts: {}, tabLayouts: {}, resources: {} } })
  const fd = await open(join(f.original.root, 'private-semantic-lease'), 'a+')
  cleanup.push(() => fd.close())
  const inner = f.original.client as unknown as { spawnFiniteFileProducer: (spawn: (fd: number) => import('node:child_process').ChildProcess) => import('node:child_process').ChildProcess }
  inner.spawnFiniteFileProducer = spawn => spawn(fd.fd)
  f.original.inner.kernel.listPage = async () => ({ runs: [], nextCursor: null })
  const notes = new core.AgentMuxNotebookStore(join(f.original.root, 'notebooks.json'))
  const owner = new FilePathMutations({ directory: join(f.original.root, 'file-path-mutations'), files: f.ordinary,
    directoryScope: predicate => f.original.client.retainExecutionDirectoryMutation(predicate), nameAudit: new NameChangeAudit(spatial),
    noteLease: work => notes.runWithWriteLease(work), notes: { plan: (from, to) => notes.planFileRelocation(from, to), apply: (plan, operationId, actor) => notes.applyFileRelocation(plan, operationId, actor) } })
  const request = async (source: string, destination: string, operationId: string): Promise<FileMoveParams> => {
    const from = await owner.stat(f.workspace, source), to = await owner.stat(f.workspace, destination)
    if (from.entry.kind === 'absent') throw new Error('Source fixture absent')
    return { zoneId: 'original-files-zone', path: source, operationId, expectedResource: f.descriptor(source), expected: { root: from.root, parent: from.parent, entry: from.entry },
      destination: { zoneId: 'original-files-zone', path: destination, expectedResource: f.descriptor(destination), expectedAbsent: true, expected: { root: to.root, parent: to.parent } } }
  }
  return { ...f, owner, spatial, notes, moveRequest: request }
}

it('compiled CLI consumes exact Host move, original name audit and read-only receipt without changing Agent Run/cwd', async () => {
  const f = await hostFixture(), originalStore = await readFile(f.original.store.path)
  await writeFile(join(f.root, 'original.txt'), 'original bytes')
  const descriptor = { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root }
  const from = await f.cli(['stat'], { zoneId: 'original-files-zone', path: 'original.txt', expectedResource: descriptor })
  const to = await f.cli(['stat'], { zoneId: 'original-files-zone', path: 'renamed.txt', expectedResource: descriptor })
  expect(from.code, from.stderr).toBe(0); expect(to.code, to.stderr).toBe(0)
  const a = from.body.result, b = to.body.result
  const input: FileMoveParams = { zoneId: 'original-files-zone', path: 'original.txt', operationId: 'host-original-move', expectedResource: a.resource,
    expected: { root: a.result.observation.root, parent: a.result.observation.parent, entry: a.result.observation.entry },
    destination: { zoneId: 'original-files-zone', path: 'renamed.txt', expectedResource: b.resource, expectedAbsent: true, expected: { root: b.result.observation.root, parent: b.result.observation.parent } } }
  const moved = await f.cli(['move'], input)
  expect(moved.code, moved.stderr).toBe(0)
  expect((await f.spatial.listNameChanges()).find(record => record.id === input.operationId + '/name/0')).toMatchObject({ status: 'applied', actual: 'renamed.txt', context: { actor: { kind: 'agent', id: agent.actor.id, verified: true }, entryPoint: 'file.move', location: { callerHostId: 'local' } } })
  expect(moved.body.result.result).toMatchObject({ action: 'move', filesystem: 'moved', durability: 'confirmed', nameAudit: { status: 'recorded' } })
  expect(await readFile(join(f.root, 'renamed.txt'), 'utf8')).toBe('original bytes')
  const inspected = await f.cli(['mutation', 'inspect'], { zoneId: input.zoneId, path: input.path, expectedResource: input.expectedResource, operationId: input.operationId })
  expect(inspected.code, inspected.stderr).toBe(0)
  expect(inspected.body.result.result).toMatchObject({ action: 'move', filesystem: 'moved', durability: 'unconfirmed', original: input })
  expect((await f.cli(['move'], input)).body.result.result).toMatchObject({ filesystem: 'moved', durability: 'unconfirmed' })
  expect((await f.cli(['move'], { ...input, destination: { ...input.destination, path: 'another.txt', expectedResource: { ...b.resource, path: 'another.txt' } } })).code).toBe(1)
  expect(await readFile(f.original.store.path)).toEqual(originalStore)
  expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
  facts.push({ scenario: 'compiled-cli-host-native-move', operationId: input.operationId, moved: moved.body.result.result, inspected: inspected.body.result.result, originalRunStoreUnchanged: true })
})

it('native move preserves inode and rejects changed source, destination occupation and late parent exchange', async () => {
  const f = await moveFixture(); await writeFile(join(f.root, 'source'), 'same bytes')
  const input = await f.moveRequest('source', 'destination', 'source-generation')
  await rename(join(f.root, 'source'), join(f.root, 'old-source')); await writeFile(join(f.root, 'source'), 'same bytes')
  expect((await f.owner.move(f.workspace, input, agent)).result).toMatchObject({ filesystem: 'not-applied', code: 'FILE_MOVE_SOURCE_CONFLICT' })
  const swapped = await moveFixture({ beforeMoveClaim: async () => { await rename(join(swapped.root, 'source'), join(swapped.root, 'old-source')); await writeFile(join(swapped.root, 'source'), 'replacement bytes') } })
  await writeFile(join(swapped.root, 'source'), 'original bytes')
  const swappedInput = await swapped.moveRequest('source', 'destination', 'late-source-generation')
  expect((await swapped.owner.move(swapped.workspace, swappedInput, agent)).result.filesystem).toBe('not-applied')
  expect(await readFile(join(swapped.root, 'source'), 'utf8')).toBe('replacement bytes')
  expect(await readFile(join(swapped.root, 'old-source'), 'utf8')).toBe('original bytes')
  const occupied = await moveFixture({ beforeMovePublish: async () => { await writeFile(join(occupied.root, 'destination'), 'keep occupant') } })
  await writeFile(join(occupied.root, 'source'), 'original')
  const occupiedInput = await occupied.moveRequest('source', 'destination', 'later-move-occupant')
  expect((await occupied.owner.move(occupied.workspace, occupiedInput, agent)).result.filesystem).toBe('not-applied')
  expect(await readFile(join(occupied.root, 'source'), 'utf8')).toBe('original')
  expect(await readFile(join(occupied.root, 'destination'), 'utf8')).toBe('keep occupant')
  const late = await moveFixture({ beforeMovePublish: async () => {
    await rename(join(late.root, 'parent'), join(late.root, 'original-parent')); await mkdir(join(late.root, 'parent'))
    await writeFile(join(late.root, 'parent/destination'), 'replacement parent occupant')
  } })
  await mkdir(join(late.root, 'parent')); await writeFile(join(late.root, 'source'), 'keep original')
  const lateInput = await late.moveRequest('source', 'parent/destination', 'late-move-parent')
  const outcome = await late.owner.move(late.workspace, lateInput, agent)
  expect(outcome.result.filesystem).not.toBe('moved')
  expect(await readFile(join(late.root, 'parent/destination'), 'utf8')).toBe('replacement parent occupant')
  expect(await readFile(join(late.root, 'original-parent/destination'), 'utf8')).toBe('keep original')
})

it('claimed and published unknowns retain original identity, reject member loss and never redispatch', async () => {
  for (const fault of ['move-after-claim-ack-crash', 'move-after-publish-crash']) {
    const f = await moveFixture({ moveFault: fault }); await writeFile(join(f.root, 'source'), 'retained bytes')
    const input = await f.moveRequest('source', 'destination', fault), producer = vi.spyOn(f.ordinary, 'movePath')
    expect((await f.owner.move(f.workspace, input, agent)).result.filesystem).toBe('unknown')
    const observed = await f.owner.inspect({ zoneId: input.zoneId, path: input.path, operationId: input.operationId, expectedResource: input.expectedResource }, agent, f.workspace)
    if (fault.includes('publish')) expect(observed.result).toMatchObject({ filesystem: 'moved', durability: 'unconfirmed' })
    await f.owner.move(f.workspace, input, agent); expect(producer).toHaveBeenCalledTimes(1)
    await unlink(operationRecord(f.original.root, input.operationId))
    expect((await f.owner.move(f.workspace, input, agent)).result).toMatchObject({ filesystem: 'unknown', code: 'FILE_MUTATION_RECORD_UNAVAILABLE' })
    expect(producer).toHaveBeenCalledTimes(1)
  }
})

it('original retained directory projection and external cwd aliases veto only related moves', async () => {
  const f = await moveFixture(); await mkdir(join(f.root, 'source')); await mkdir(join(f.root, 'source/child'))
  const alias = join(f.original.root, 'external-alias'); await symlink(join(f.root, 'source/child'), alias)
  const input = await f.moveRequest('source', 'destination', 'retained-cwd-alias')
  const list = vi.spyOn(f.original.store, 'retainedExecutionDirectories').mockResolvedValue([alias])
  expect((await f.owner.move(f.workspace, input, agent)).result).toMatchObject({ filesystem: 'not-applied', code: 'EXECUTION_DIRECTORY_REFERENCED', nameAudit: { status: 'recorded' } })
  expect(await stat(join(f.root, 'source'))).toBeDefined()
  list.mockRestore()
  const scope = f.original.client.retainExecutionDirectoryMutation(async cwd => cwd === join(f.root, 'source'))
  try {
    await expect(f.original.client.withExecutionDirectoryAdmission(join(f.root, 'source'), async () => { throw new Error('Must not dispatch') })).rejects.toMatchObject({ code: 'EXECUTION_DIRECTORY_MUTATION_IN_PROGRESS' })
    expect(await f.original.client.withExecutionDirectoryAdmission(join(f.root, 'unrelated'), async () => 'healthy')).toBe('healthy')
  } finally { scope.release() }
})

it('original Core startup stays BUSY after parent exit while the finite product helper holds FD7, then reopens the same identity through a new socket', async () => {
  const f = await fixture()
  await writeFile(join(f.root, 'source'), 'late finite original bytes')
  const from = await f.ordinary.statPath(f.workspace, 'source'), to = await f.ordinary.statPath(f.workspace, 'destination')
  if (from.entry.kind === 'absent') throw new Error('Source absent')
  const runtime = join(f.original.root, 'private-runtime'), state = join(f.original.root, 'private-state')
  await mkdir(runtime); await mkdir(state)
  const bundle = resolve('apps/host/.local/finite-producer-' + process.pid + '.mjs')
  await mkdir(resolve('apps/host/.local'), { recursive: true })
  const { build } = createRequire(new URL('../package.json', import.meta.url))('esbuild')
  await build({ entryPoints: [resolve('apps/host/src/workspace-file-worker.ts')], outfile: bundle, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24' })
  cleanup.push(() => rm(bundle, { force: true }))
  const wrapper = join(f.original.root, 'finite-helper')
  const wrapperSource = await readFile(resolve('apps/host/test/helpers/finite-file-producer-wrapper.mjs'), 'utf8')
  await writeFile(wrapper, wrapperSource.replace('#!/usr/bin/env node', '#!' + process.execPath)); await chmod(wrapper, 0o700)
  const evidence = join(f.original.root, 'finite-producer'), configuration = join(f.original.root, 'lease-proof.json')
  await writeFile(configuration, JSON.stringify({ state, runtime, workspace: f.root, evidence, wrapper, nativeHelper: helper,
    coreEntry: resolve('packages/core/dist/index.js'), workerEntry: bundle, originalSocket: join(runtime, 'original.sock'), contenderSocket: join(runtime, 'new.sock'),
    request: { action: 'path-move', path: 'source', destination: { root: f.root, path: 'destination' }, stage: '.agentmux-move-finite-lease',
      expected: { root: from.root, parent: from.parent, entry: from.entry }, destinationExpected: { root: to.root, parent: to.parent } } }))
  const childEntry = resolve('apps/host/test/helpers/file-producer-owner-child.mjs')
  const closing = await promisify(execFile)(process.execPath, [childEntry, 'closing', configuration], { timeout: 10000 })
  expect(JSON.parse(closing.stdout.trim())).toEqual({ closingBorrowCode: 'RUNTIME_OWNER_CLOSING' })
  const parent = spawn(process.execPath, [childEntry, 'producer', configuration], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let errors = ''; parent.stderr.on('data', value => errors += value); parent.stdout.on('data', value => errors += value)
  cleanup.push(async () => { if (parent.exitCode === null && parent.signalCode === null) { const ended = once(parent, 'exit'); parent.kill('SIGKILL'); await ended } })
  const [message] = await once(parent, 'message') as [{ identity: { runtimeId: string }; pid: number }]
  let producer: { pid: number; nativePid: number; inheritedFd7: boolean } | undefined
  await vi.waitFor(async () => { producer = JSON.parse(await readFile(evidence + '.ready', 'utf8')); expect(producer!.pid).toBeGreaterThan(0) }, { timeout: 10000 })
  cleanup.push(async () => {
    await writeFile(evidence + '.release', 'G')
    for (const pid of [producer?.nativePid, producer?.pid]) if (pid) { try { process.kill(pid, 'SIGTERM') } catch {} }
  })
  const exit = once(parent, 'exit'); parent.kill('SIGKILL'); await exit
  expect(() => process.kill(message.pid, 0)).toThrow()
  const runProbe = async () => {
    const probe = await promisify(execFile)(process.execPath, [childEntry, 'probe', configuration], { timeout: 10000 })
    return JSON.parse(probe.stdout.trim())
  }
  expect(await runProbe(), errors).toMatchObject({ acquired: false, code: 'RUNTIME_OWNER_BUSY' })
  await expect(readFile(join(runtime, 'new.sock.owner.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  await writeFile(evidence + '.release', 'G')
  await vi.waitFor(async () => { expect(JSON.parse(await readFile(evidence + '.closed', 'utf8'))).toEqual({ code: 0 }) }, { timeout: 10000 })
  expect(await readFile(join(f.root, 'destination'), 'utf8')).toBe('late finite original bytes')
  const replacement = await runProbe()
  expect(replacement).toMatchObject({ acquired: true, identity: { runtimeId: message.identity.runtimeId } })
  facts.push({ scenario: 'actual-core-finite-producer-lease', originalParent: message.pid, originalIdentity: message.identity, producer, parentExitBeforeCompetition: true, contenderSocket: join(runtime, 'new.sock'), semanticBusyWhileEffectPossible: true, endpointLockAbsentDuringBusy: true, closingBorrowRevokedSynchronously: true, finiteProducerClosed: true, replacementIdentity: replacement.identity })
}, 30000)

it('directory move relocates registered and unregistered original Note history/creators atomically under the original Notes lease', async () => {
  const f = await moveFixture(); await mkdir(join(f.root, 'source'))
  const actor = { kind: 'user' as const, id: 'original-note-person' }
  const originals = []
  for (const registered of [true, false]) {
    const noteId = registered ? 'registered-original' : 'unregistered-original', resource = { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root, path: 'source/' + noteId + '.note.md' }
    const content = 'Original ' + noteId + '\n', revision = noteHistoryRevision(content)
    await writeFile(join(f.root, resource.path), content)
    if (registered) await f.notes.apply({ expectedRevision: 0, operationId: 'register-original-note', change: { kind: 'register', noteId, resource, title: 'Original' } }, actor)
    const provenance = { noteId, resource, revision, blocks: { original: { created: { actor, at: 1 }, lastEdited: { actor, at: 2 } } } }
    await f.notes.recordProvenance(provenance)
    await f.notes.recordHistory({ eventId: noteId + '-edit', sequence: 0, batchId: noteId + '-batch', noteId, resource, originalResource: resource,
      status: 'committed', actor, at: 2, operation: 'edit', parentEventId: null, requestFingerprint: noteId + '-request', beforeContent: null, baseRevision: null, content, revision, provenance })
    originals.push({ noteId, resource, content, revision, provenance })
  }
  const input = await f.moveRequest('source', 'destination', 'directory-original-notes'), producer = vi.spyOn(f.ordinary, 'movePath')
  let release!: () => void, acquired!: () => void
  const locked = new Promise<void>(yes => acquired = yes)
  const held = f.notes.runWithWriteLease(async () => { acquired(); await new Promise<void>(yes => release = yes) })
  // The lease begins asynchronously after ready(); install its observer first.
  await locked
  let leaseEntered = false
  const originalLease = f.notes.runWithWriteLease.bind(f.notes)
  vi.spyOn(f.notes, 'runWithWriteLease').mockImplementation(work => { leaseEntered = true; return originalLease(work) })
  const moving = f.owner.move(f.workspace, input, agent)
  let result!: Awaited<typeof moving>
  try {
    await vi.waitFor(() => expect(leaseEntered || producer.mock.calls.length > 0).toBe(true))
    expect(producer).not.toHaveBeenCalled()
    expect(await f.ordinary.statPath(f.workspace, 'source')).toBeDefined()
    await f.ordinary.write(f.workspace, { path: 'unrelated.txt', content: 'healthy ordinary write', expectedRevision: null })
    expect(await readFile(join(f.root, 'unrelated.txt'), 'utf8')).toBe('healthy ordinary write')
  }
  finally { release(); await held; result = await moving }
  expect(result.result, JSON.stringify(result)).toMatchObject({ filesystem: 'moved', noteMetadata: { status: 'recorded' } })
  const reopened = new core.AgentMuxNotebookStore(f.notes.path)
  for (const original of originals) {
    const destination = { ...original.resource, path: original.resource.path.replace('source/', 'destination/') }
    expect(await readFile(join(f.root, destination.path), 'utf8')).toBe(original.content)
    expect(await reopened.readHistoryOperation(original.noteId + '-edit')).toMatchObject({ eventId: original.noteId + '-edit', actor, resource: destination, originalResource: original.resource, content: original.content })
    expect(await reopened.readProvenance({ noteId: original.noteId, resource: destination, revision: original.revision, blockIds: ['original'] })).toMatchObject({ blocks: original.provenance.blocks })
  }
  expect((await reopened.read()).pages['registered-original']!.resource.path).toBe('destination/registered-original.note.md')
  expect((await reopened.read()).pages['unregistered-original']).toBeUndefined()
  facts.push({ scenario: 'original-notes-relocation', operationId: input.operationId, originalIds: originals.map(value => value.noteId), creatorsPreserved: true, originalEventsPreserved: true, bodyBytesPreserved: true, noFakeRegistration: true, originalLeaseConsumed: true })
})

it('actual original Store active, retired and prepared-creation metadata retain the exact directory across owner reopen', async () => {
  const f = await moveFixture(); await mkdir(join(f.root, 'source'))
  const current = (await f.original.store.loadMetadata()).find(value => value.agentSessionId === agent.actor.id)!
  const bound = { ...current, workspacePath: join(f.root, 'source') }
  await f.original.store.compareAndSwap(current, bound)
  expect(await f.original.store.retainedExecutionDirectories('local')).toContain(bound.workspacePath)
  const first = await f.moveRequest('source', 'destination', 'active-directory-reference')
  expect((await f.owner.move(f.workspace, first, agent)).result.filesystem).toBe('not-applied')
  const reservation = { reservationId: 'retire-original-directory', ownerId: 'private-directory-owner', ownerPid: process.pid, kind: 'stop' as const,
    agentSessionId: bound.agentSessionId, operationId: 'retire-original-directory', expiresAt: Date.now() + 60000, expectedRun: bound.run,
    stopOperation: { daemonInstance: 'fixture-runtime', operationKey: 'retire-original-directory', runId: bound.run.runId } }
  await f.original.store.reserveLifecycle(reservation); await f.original.store.commitLifecycle(reservation, null)
  const reopened = new core.AgentMuxFileAgentSessionStore(f.original.store.path)
  expect(await reopened.retainedExecutionDirectories('local')).toContain(bound.workspacePath)
  const second = await f.moveRequest('source', 'destination', 'retired-directory-reference')
  expect((await f.owner.move(f.workspace, second, agent)).result.filesystem).toBe('not-applied')
  const { run, retiredRuns, ...seed } = bound
  const creation = { reservationId: 'prepared-directory-creation', ownerId: 'private-directory-owner', ownerPid: process.pid, kind: 'create' as const,
    agentSessionId: 'new-prepared-directory-agent', operationId: 'prepared-directory-creation', expiresAt: Date.now() + 60000,
    preparedCreation: { ...seed, agentSessionId: 'new-prepared-directory-agent', workspacePath: join(f.root, 'other-pending'), creation: { createOperationId: 'prepared-directory-creation', intentDigest: 'a'.repeat(64), initialPrompt: 'not-requested' as const } } }
  await f.original.store.reserveLifecycle(creation)
  expect(await reopened.retainedExecutionDirectories('local')).toContain(creation.preparedCreation.workspacePath)
  expect(await reopened.retainedExecutionDirectories('other-host')).toEqual([])
})

it('actual createTerminal consumer is scoped before awaits and frozen admission survives its completion during reference reads', async () => {
  const f = await moveFixture(), cwd = join(f.root, 'new-execution')
  await mkdir(cwd)
  const scope = f.original.client.retainExecutionDirectoryMutation(async value => value === cwd)
  const prepare = vi.spyOn(f.original.client, 'prepareTerminal').mockRejectedValue(new Error('Unapproved preparation reached'))
  try {
    await expect(f.original.client.createTerminal({ command: process.execPath, workspacePath: cwd })).rejects.toMatchObject({ code: 'EXECUTION_DIRECTORY_MUTATION_IN_PROGRESS' })
    expect(prepare).not.toHaveBeenCalled()
  } finally { scope.release(); prepare.mockRestore() }
  let release!: () => void
  const pending = vi.spyOn(f.original.client, 'prepareTerminal').mockImplementation(async () => { await new Promise<void>(yes => release = yes); throw new Error('Private preparation finished without dispatch') })
  const creation = f.original.client.createTerminal({ command: process.execPath, workspacePath: cwd }).catch(error => error)
  await vi.waitFor(() => expect(pending).toHaveBeenCalledTimes(1))
  const frozen = f.original.client.retainExecutionDirectoryMutation(async value => value === cwd)
  release(); await creation
  try { await expect(frozen.assertUnreferenced()).rejects.toMatchObject({ code: 'EXECUTION_DIRECTORY_REFERENCED' }) }
  finally { frozen.release() }
})

it('a real fresh Files owner process observes the original operation and member loss without issuing another physical move', async () => {
  const f = await moveFixture({ moveFault: 'move-after-publish-crash' }); await writeFile(join(f.root, 'source'), 'original move bytes')
  const input = await f.moveRequest('source', 'destination', 'private-owner-reopen')
  expect((await f.owner.move(f.workspace, input, agent)).result.filesystem).toBe('unknown')
  const bundle = resolve('apps/host/.local/file-operation-observer-' + process.pid + '.mjs')
  const { build } = createRequire(new URL('../package.json', import.meta.url))('esbuild')
  await mkdir(resolve('apps/host/.local'), { recursive: true })
  await build({ stdin: { resolveDir: process.cwd(), contents: "export { FilePathMutations } from './apps/host/src/file-path-mutations.ts'; export { OrdinaryWorkspaceFiles } from './apps/host/src/ordinary-files.ts'" }, outfile: bundle, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24' })
  cleanup.push(() => rm(bundle, { force: true }))
  const configuration = join(f.original.root, 'owner-observe.json')
  await writeFile(configuration, JSON.stringify({ entry: bundle, helper, directory: join(f.original.root, 'file-path-mutations'), workspace: f.workspace, input, context: agent }))
  const invoke = async () => JSON.parse((await promisify(execFile)(process.execPath, [resolve('apps/host/test/helpers/file-path-operation-observer.mjs'), configuration])).stdout)
  const first = await invoke()
  expect(first, JSON.stringify(first)).toMatchObject({ publishCalls: 0, result: { result: { filesystem: 'moved', durability: 'unconfirmed' } } })
  await unlink(operationRecord(f.original.root, input.operationId))
  await rename(join(f.root, 'destination'), join(f.root, 'source'))
  expect(await invoke()).toMatchObject({ publishCalls: 0, result: { result: { filesystem: 'unknown', code: 'FILE_MUTATION_RECORD_UNAVAILABLE' } } })
  expect(await readFile(join(f.root, 'source'), 'utf8')).toBe('original move bytes')
  await writeFile(join(f.root, 'unrelated'), 'healthy unrelated bytes')
  const next = await f.moveRequest('unrelated', 'healthy-destination', 'independent-operation')
  const normal = new FilePathMutations({ directory: join(f.original.root, 'file-path-mutations'), files: new OrdinaryWorkspaceFiles({ helperPath: helper }),
    directoryScope: predicate => f.original.client.retainExecutionDirectoryMutation(predicate), nameAudit: new NameChangeAudit(f.spatial), noteLease: work => f.notes.runWithWriteLease(work), notes: { plan: (from, to) => f.notes.planFileRelocation(from, to), apply: (plan, id, actor) => f.notes.applyFileRelocation(plan, id, actor) } })
  expect((await normal.move(f.workspace, next, agent)).result.filesystem).toBe('moved')
  facts.push({ scenario: 'private-node-owner-reopen', operationId: input.operationId, originalObserved: first, missingRequestMemberNeverRepublished: true, exactOriginalEntryReturnedBeforeRetry: true, independentOperation: next.operationId })
})

it('real private Native Agent cwd survives a related Files veto and original recovery is blocked only during the exact mutation scope', async () => {
  const native = await executableNativeFixture('configured-path'), source = join(native.root, 'source')
  await mkdir(source)
  const created = await native.client.createAgent({ providerId: 'claude', executorId: 'fixture', workspacePath: source, commandOverride: native.executable,
    env: native.env, injectAgentMuxGuide: false, prompt: 'original directory task' })
  const first = await native.receipt(created)
  expect(first.cwd).toBe(source)
  await until(() => native.client.agentSession(created.agentSessionId), value => Boolean(value.nativeHandle))
  const files = new OrdinaryWorkspaceFiles({ helperPath: helper }), workspace = { id: 'native-original', hostId: 'local', path: native.root }
  const spatial = new core.AgentMuxSpatialStateStore()
  await spatial.commit({ expectedRevision: 0, graph: { spaces: [], zones: [], bindings: [], tabs: [], regions: [], layouts: {}, tabLayouts: {}, resources: {} } })
  const owner = new FilePathMutations({ directory: join(native.root, 'file-path-mutations'), files, nameAudit: new NameChangeAudit(spatial),
    directoryScope: predicate => native.client.retainExecutionDirectoryMutation(predicate), noteLease: work => work(), notes: { plan: async (from, to) => ({ root: null, from: { hostId: from.hostId, workspaceId: from.workspaceId, workspacePath: from.workspacePath, path: from.path }, to: { hostId: to.hostId, workspaceId: to.workspaceId, workspacePath: to.workspacePath, path: to.path }, entries: [] }), apply: async () => {} } })
  const from = await files.statPath(workspace, 'source'), to = await files.statPath(workspace, 'destination')
  if (from.entry.kind === 'absent') throw new Error('Original cwd missing')
  const descriptor = (path: string) => ({ hostId: 'local', workspaceId: workspace.id, workspacePath: native.root, zoneId: 'native-zone', zonePath: native.root, path })
  const input: FileMoveParams = { operationId: 'native-retained-cwd', zoneId: 'native-zone', path: 'source', expectedResource: descriptor('source'), expected: { root: from.root, parent: from.parent, entry: from.entry },
    destination: { zoneId: 'native-zone', path: 'destination', expectedResource: descriptor('destination'), expectedAbsent: true, expected: { root: to.root, parent: to.parent } } }
  expect((await owner.move(workspace, input, agent)).result.filesystem).toBe('not-applied')
  expect(() => process.kill(first.pid, 0)).not.toThrow()
  expect((await native.client.statusAgent(created.agentSessionId)).run).toMatchObject({ runId: created.run.runId, state: 'running', workspacePath: source })
  await native.exit(created)
  const scope = native.client.retainExecutionDirectoryMutation(async cwd => cwd === source)
  try {
    await expect(native.client.resumeAgent({ agentSessionId: created.agentSessionId, operationId: 'scoped-native-resume', prompt: 'continue original', commandOverride: native.executable, env: native.env })).rejects.toMatchObject({ code: 'EXECUTION_DIRECTORY_MUTATION_IN_PROGRESS' })
  } finally { scope.release() }
  const resumed = await native.client.resumeAgent({ agentSessionId: created.agentSessionId, operationId: 'unscoped-native-resume', prompt: 'continue original', commandOverride: native.executable, env: native.env })
  expect(resumed.agentSessionId).toBe(created.agentSessionId)
  const nextReceipt = await native.receipt(resumed)
  expect(nextReceipt.cwd).toBe(source)
  facts.push({ scenario: 'private-native-agent-cwd-and-recovery', originalSessionId: created.agentSessionId, originalRun: created.run, originalReceipt: first, healthyRunSurvivedVeto: true, sameSessionRecoveredAfterScopeRelease: true, recoveredReceipt: nextReceipt })
}, 45000)

it('a new createTerminal admission after the final reference check cannot pass the original finite move publication scope', async () => {
  const f = await moveFixture({ beforeMovePublish: async () => {
    await expect(f.original.client.createTerminal({ command: process.execPath, workspacePath: join(f.root, 'source') })).rejects.toMatchObject({ code: 'EXECUTION_DIRECTORY_MUTATION_IN_PROGRESS' })
    expect(await f.original.client.withExecutionDirectoryAdmission(join(f.root, 'unrelated'), async () => 'healthy')).toBe('healthy')
  } })
  await mkdir(join(f.root, 'source'))
  const dispatch = vi.fn(async () => { throw new Error('Native start must not be reached under this exact directory scope') })
  f.original.inner.kernel.startPrepared = dispatch
  const input = await f.moveRequest('source', 'destination', 'late-creation-before-publication')
  expect((await f.owner.move(f.workspace, input, agent)).result.filesystem).toBe('moved')
  expect(dispatch).not.toHaveBeenCalled()
})

it('compiled Host move retains the original primary Mote while ordinary contained files remain manageable', async () => {
  const f = await hostFixture(), name = scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID)
  await mkdir(join(f.root, name)); await writeFile(join(f.root, name, 'keep.txt'), 'primary contents')
  const config = JSON.parse(await readFile(f.configurationPath, 'utf8'))
  config.workspaces.push({ id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: f.root, name: 'Private primary Mote' })
  await writeFile(f.configurationPath, JSON.stringify(config))
  const resource = { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root }
  const move = async (path: string, destination: string, operationId: string) => {
    const from = (await f.cli(['stat'], { zoneId: 'original-files-zone', path, expectedResource: resource })).body.result
    const to = (await f.cli(['stat'], { zoneId: 'original-files-zone', path: destination, expectedResource: resource })).body.result
    return f.cli(['move'], { zoneId: 'original-files-zone', path, operationId, expectedResource: from.resource,
      expected: { root: from.result.observation.root, parent: from.result.observation.parent, entry: from.result.observation.entry },
      destination: { zoneId: 'original-files-zone', path: destination, expectedResource: to.resource, expectedAbsent: true, expected: { root: to.result.observation.root, parent: to.result.observation.parent } } })
  }
  const retained = await move(name, 'forbidden', 'retain-primary-mote')
  expect(retained.code, retained.stderr).toBe(0)
  expect(retained.body.result.result).toMatchObject({ filesystem: 'not-applied', code: 'PRIMARY_MOTE_PROTECTED' })
  expect(retained.body.result.result.message).toContain('primary Mote')
  expect(await readFile(join(f.root, name, 'keep.txt'), 'utf8')).toBe('primary contents')
  const ordinary = await move(name + '/keep.txt', name + '/renamed.txt', 'manage-primary-content')
  expect(ordinary.code, ordinary.stderr).toBe(0)
  expect(ordinary.body.result.result.filesystem).toBe('moved')
})

it('compiled Host move relocates registered ordinary txt resources and original history without suffix inference', async () => {
  const f = await hostFixture(), notes = new core.AgentMuxNotebookStore(), actor = { kind: 'user' as const, id: 'plain-file-creator' }
  const resource = { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root, path: 'source.txt' }, content = 'Original ordinary registered text\n', revision = noteHistoryRevision(content)
  await writeFile(join(f.root, resource.path), content)
  await notes.apply({ expectedRevision: 0, operationId: 'register-plain-file', change: { kind: 'register', noteId: 'plain-file-note', title: 'Plain file', resource } }, actor)
  await notes.recordHistory({ eventId: 'plain-file-event', sequence: 0, batchId: 'plain-file-batch', noteId: 'plain-file-note', resource, originalResource: resource,
    status: 'committed', actor, at: 1, operation: 'edit', parentEventId: null, requestFingerprint: 'plain-file-original-request', beforeContent: null, baseRevision: null, content, revision })
  const before = await f.cli(['stat'], { zoneId: 'original-files-zone', path: 'source.txt', expectedResource: { hostId: resource.hostId, workspaceId: resource.workspaceId, workspacePath: resource.workspacePath } })
  const after = await f.cli(['stat'], { zoneId: 'original-files-zone', path: 'destination.txt', expectedResource: { hostId: resource.hostId, workspaceId: resource.workspaceId, workspacePath: resource.workspacePath } })
  expect(before.code, before.stderr).toBe(0); expect(after.code, after.stderr).toBe(0)
  const a = before.body.result, b = after.body.result
  const input: FileMoveParams = { zoneId: 'original-files-zone', path: 'source.txt', operationId: 'move-registered-plain-file', expectedResource: a.resource,
    expected: { root: a.result.observation.root, parent: a.result.observation.parent, entry: a.result.observation.entry },
    destination: { zoneId: 'original-files-zone', path: 'destination.txt', expectedResource: b.resource, expectedAbsent: true, expected: { root: b.result.observation.root, parent: b.result.observation.parent } } }
  const moved = await f.cli(['move'], input)
  expect(moved.code, moved.stderr).toBe(0)
  expect(moved.body.result.result).toMatchObject({ filesystem: 'moved', noteMetadata: { status: 'recorded' } })
  const fresh = new core.AgentMuxNotebookStore()
  expect((await fresh.read()).pages['plain-file-note']!.resource).toEqual({ ...resource, path: 'destination.txt' })
  expect(await fresh.readHistoryOperation('plain-file-event')).toMatchObject({ actor, content, originalResource: resource, resource: { ...resource, path: 'destination.txt' } })
})

it('original Capsule pre-launch and retained command seeds remain unknown directory references without guessing a Runtime', async () => {
  const f = await moveFixture(), manager = new CapsuleRunManager(f.original.client as never, join(f.original.root, 'capsule-owner'))
  cleanup.push(() => manager.dispose())
  vi.spyOn(f.original.client, 'connectRuntime').mockRejectedValue(new core.AgentMuxError('Private Native observation unavailable', 'CTXMUX_DISCONNECTED'))
  const observation = await manager.runtime.call('capsule.runtime.start', { operationId: 'retain-prelaunch-capsule', expectedRevision: 0 })
  expect(observation.desired).toBe('running')
  expect(await manager.retainedExecutionDirectories()).toContainEqual({ workspacePath: manager.stateDirectory, runtimeId: null })
  const inner = f.original.client as unknown as { retainedServiceExecutionDirectories: () => ReturnType<typeof manager.retainedExecutionDirectories> }
  inner.retainedServiceExecutionDirectories = () => manager.retainedExecutionDirectories()
  const scope = f.original.client.retainExecutionDirectoryMutation(async cwd => cwd === manager.stateDirectory)
  try { await expect(scope.assertUnreferenced()).rejects.toMatchObject({ code: 'EXECUTION_DIRECTORY_REFERENCES_UNCONFIRMED' }) }
  finally { scope.release() }
  const unrelated = f.original.client.retainExecutionDirectoryMutation(async () => false)
  try { await unrelated.assertUnreferenced() } finally { unrelated.release() }
  const command = join(f.original.root, 'capsule-owner/capsule-service-operations/retain-prelaunch-capsule.json'), bytes = await readFile(command)
  await unlink(join(f.original.root, 'capsule-owner/capsule-service.json'))
  expect(await manager.retainedExecutionDirectories()).toContainEqual({ workspacePath: manager.stateDirectory, runtimeId: null })
  expect(await readFile(command)).toEqual(bytes)
})

it('compiled CLI rejects moved receipts for another source identity and binds inspected witness to its returned original request', async () => {
  const f = await moveFixture(); await writeFile(join(f.root, 'source'), 'original codec bytes')
  const input = await f.moveRequest('source', 'destination', 'original-codec-move'), socket = join(f.original.root, 'receipt-codec.sock')
  let witness = { ...input.expected.entry.witness }, unknown = false
  const receipt = () => unknown ? { action: 'move', phase: 'prepared', filesystem: 'unknown', durability: 'unconfirmed', code: 'ORIGINAL_RECEIPT_UNKNOWN', message: 'Keep the original request; this controlled owner has no confirmed physical reply.' }
    : { action: 'move', phase: 'settled', filesystem: 'moved', durability: 'confirmed', movedWitness: witness }
  const owner = { move: async () => ({ operationId: input.operationId, resource: input.expectedResource, destination: input.destination.expectedResource, result: receipt() }),
    inspectMutation: async () => ({ operationId: input.operationId, resource: input.expectedResource, result: { ...receipt(), original: input } }) }
  const server = new core.AgentMuxControlServer({ coreClients: f.original.coreClients, files: owner as never }, socket)
  await server.start(); cleanup.push(() => server.stop())
  const env = objectCliEnvironment(f.original.root, { AGENTMUX_AGENT_SESSION_ID: agent.actor.id, AGENTMUX_AGENT_CAPABILITY: f.original.capability })
  const cli = (action: string[], value: unknown) => runCompiledObjectCli(['--endpoint', 'unix:' + socket, 'file', ...action, '--input', '-'], env, JSON.stringify(value))
  const query = { zoneId: input.zoneId, path: input.path, operationId: input.operationId, expectedResource: input.expectedResource }
  for (const field of ['device', 'inode', 'birthtimeNs'] as const) {
    witness = { ...input.expected.entry.witness, [field]: '987654321' }
    for (const [action, value] of [[['move'], input], [['mutation', 'inspect'], query]] as const) {
      const rejected = await cli([...action], value)
      expect(rejected.code, rejected.stdout + rejected.stderr).toBe(1)
      expect(rejected.stdout + rejected.stderr).toContain('CONTROL_PROTOCOL_ERROR')
    }
  }
  unknown = true
  const retained = await cli(['move'], input)
  expect(retained.code, retained.stderr).toBe(0)
  expect(JSON.parse(retained.stdout).result.result).toMatchObject({ filesystem: 'unknown', code: 'ORIGINAL_RECEIPT_UNKNOWN' })
  expect(await readFile(join(f.root, 'source'), 'utf8')).toBe('original codec bytes')
})

it('missing native generation refuses only the exact move and never invents a changed source', async () => {
  for (const part of ['root', 'parent', 'entry'] as const) {
    const f = await moveFixture(); await writeFile(join(f.root, 'source'), 'generation unavailable bytes')
    const input = await f.moveRequest('source', 'destination', 'missing-generation-' + part), current = await f.ordinary.statPath(f.workspace, 'source')
    if (current.entry.kind === 'absent') throw new Error('Source absent')
    if (part === 'entry') current.entry.witness.birthtimeNs = null; else current[part].birthtimeNs = null
    vi.spyOn(f.ordinary, 'statPath').mockResolvedValue(current)
    const producer = vi.spyOn(f.ordinary, 'movePath')
    expect((await f.owner.move(f.workspace, input, agent)).result).toMatchObject({ filesystem: 'not-applied', code: 'FILE_PATH_GENERATION_UNAVAILABLE' })
    expect(producer).not.toHaveBeenCalled()
    const read = await f.ordinary.read(f.workspace, 'source')
    expect(read).toMatchObject({ status: 'read', document: { content: 'generation unavailable bytes' } })
  }
})

it('compiled CLI moves 1000 original Notes with a compact pair plan, preserves duplicate-ID historical resources and reopens without redispatch', async () => {
  const f = await hostFixture('physical\nroot\\part'), notes = new core.AgentMuxNotebookStore(), count = 1000, state = await notes.read(), source = 'source', destination = 'destination'
  const actor = { kind: 'user' as const, id: 'large-original-note-creator' }
  await mkdir(join(f.root, source))
  const body = (id: string, historical = false) => '---\nschema: agentmux.note.md.v1\nnote-id: ' + id + '\n---\n\nOriginal ' + (historical ? 'historical ' : '') + id + '\n\n^original\n'
  for (let index = 0; index < count; index++) {
    const id = 'capacity-note-' + String(index).padStart(4, '0'), path = source + '/' + id + '.note.md'
    state.pages[id] = { noteId: id, notebookId: 'quick-notes', parentNoteId: null, title: id,
      resource: { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root, path }, createdAt: 1, updatedAt: 1, sources: [], topics: [] }
    await writeFile(join(f.root, path), body(id))
  }
  await publishNotebookFiles(notes.path, { incarnation: 'original-1000-note-library', state, provenance: [] })
  const probes = []
  for (const index of [0, count - 1, -1]) {
    const id = 'capacity-note-' + String(Math.max(0, index)).padStart(4, '0'), historical = index === -1
    const resource = { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root, path: source + '/' + (historical ? 'historical-same-id.note.md' : id + '.note.md') }
    const content = body(id, historical), revision = noteHistoryRevision(content), eventId = historical ? 'large-historical-event' : 'large-note-event-' + index
    if (historical) await writeFile(join(f.root, resource.path), content)
    const provenance = { noteId: id, resource, revision, blocks: { original: { created: { actor, at: 1 }, lastEdited: { actor, at: 2 } } } }
    await notes.recordProvenance(provenance)
    await notes.recordHistory({ eventId, sequence: 0, batchId: eventId, noteId: id, resource, originalResource: resource, status: 'committed', actor, at: 2,
      operation: 'edit', parentEventId: null, requestFingerprint: eventId + '-request', beforeContent: null, baseRevision: null, content, revision, provenance })
    probes.push({ id, resource, content, revision, eventId, provenance })
  }
  const target = { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root }
  const beforeCall = await f.cli(['stat'], { zoneId: 'original-files-zone', path: source, expectedResource: target })
  expect(beforeCall.code, beforeCall.stdout + beforeCall.stderr).toBe(0)
  const before = beforeCall.body.result
  const afterCall = await f.cli(['stat'], { zoneId: 'original-files-zone', path: destination, expectedResource: target })
  expect(afterCall.code, afterCall.stdout + afterCall.stderr).toBe(0)
  const after = afterCall.body.result
  const input: FileMoveParams = { zoneId: 'original-files-zone', path: source, operationId: 'large-original-note-move', expectedResource: before.resource,
    expected: { root: before.result.observation.root, parent: before.result.observation.parent, entry: before.result.observation.entry },
    destination: { zoneId: 'original-files-zone', path: destination, expectedResource: after.resource, expectedAbsent: true, expected: { root: after.result.observation.root, parent: after.result.observation.parent } } }
  const nativeMove = vi.spyOn(OrdinaryWorkspaceFiles.prototype, 'movePath'), started = performance.now(), moved = await f.cli(['move'], input), elapsedMs = performance.now() - started
  expect(moved.code, moved.stdout + moved.stderr).toBe(0)
  expect(moved.body.result.result, JSON.stringify(moved.body)).toMatchObject({ filesystem: 'moved', noteMetadata: { status: 'recorded' } })
  expect(nativeMove).toHaveBeenCalledTimes(1)
  const retained = JSON.parse(await readFile(operationRecord(f.original.root, input.operationId), 'utf8'))
  const plan = retained.notePlan, planBytes = Buffer.byteLength(JSON.stringify(plan))
  expect(plan.entries).toHaveLength(count + 1)
  expect(plan.relocations).toBeUndefined()
  expect(plan.entries.filter((entry: { noteId: string }) => entry.noteId === 'capacity-note-0000')).toHaveLength(2)
  expect(planBytes).toBeLessThan(256 * 1024 - 96 * 1024)
  const reopened = new core.AgentMuxNotebookStore(), actual = await reopened.read()
  expect(Object.keys(actual.pages)).toHaveLength(count)
  expect(await readdir(join(f.root, destination))).toHaveLength(count + 1)
  for (let index = 0; index < count; index++) {
    const id = 'capacity-note-' + String(index).padStart(4, '0'), path = destination + '/' + id + '.note.md'
    expect(actual.pages[id]!.resource).toEqual({ ...target, path })
    expect(await readFile(join(f.root, path), 'utf8')).toBe(body(id))
  }
  for (const probe of probes) {
    const resource = { ...probe.resource, path: destination + probe.resource.path.slice(source.length) }
    expect(await reopened.readHistoryOperation(probe.eventId)).toMatchObject({ eventId: probe.eventId, actor, content: probe.content, originalResource: probe.resource, resource })
    expect(await reopened.readProvenance({ noteId: probe.id, resource, revision: probe.revision, blockIds: ['original'] })).toMatchObject({ blocks: probe.provenance.blocks })
  }
  const childInput = join(f.original.root, 'large-note-reopen.json')
  await writeFile(childInput, JSON.stringify({ path: notes.path, target, destination, source, count, probes, actor }))
  const child = JSON.parse((await promisify(execFile)(process.execPath, [resolve('apps/host/test/helpers/file-note-owner-observer.mjs'), childInput])).stdout)
  expect(child).toMatchObject({ count, histories: 3, exactBodies: true, exactCreators: true })
  expect(child.pid).not.toBe(process.pid)
  expect((await f.cli(['move'], input)).body.result.result).toMatchObject({ filesystem: 'moved', durability: 'unconfirmed' })
  const query = { zoneId: input.zoneId, path: input.path, expectedResource: input.expectedResource, operationId: input.operationId }
  expect((await f.cli(['mutation', 'inspect'], query)).body.result.result).toMatchObject({ filesystem: 'moved', original: input })
  await unlink(operationRecord(f.original.root, input.operationId))
  expect((await f.cli(['move'], input)).body.result.result).toMatchObject({ filesystem: 'unknown', code: 'FILE_MUTATION_RECORD_UNAVAILABLE' })
  expect(nativeMove).toHaveBeenCalledTimes(1)
  expect((await new core.AgentMuxNotebookStore().read()).pages['capacity-note-0000']!.resource.path).toBe(destination + '/capacity-note-0000.note.md')
  facts.push({ scenario: 'compiled-cli-1000-note-compact-plan', count, physicalEntries: count + 1, entries: plan.entries.length, planBytes,
    elapsedMs, duplicateIdDistinctResources: true, allCatalogAndBodyBytesPreserved: true, originalHistoryAndCreatorsPreserved: true,
    originalMemberLossNeverRedispatched: true, nativeMoveCalls: nativeMove.mock.calls.length, destination, freshOwnerProcess: child })
}, 45000)

it('compact original Note plans bind exact pairs and preserve the original per-Note mutation receipts and root CAS', async () => {
  const f = await moveFixture(), actor = { kind: 'user' as const, id: 'original-batch-actor' }
  const from = { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root, path: 'source' }, to = { ...from, path: 'destination' }
  const plan = { root: 'a'.repeat(64), from, to, entries: [{ noteId: 'same-id', suffix: '' }, { noteId: 'same-id', suffix: '/history' }] }
  expect(parseNotebookFileRelocationPlan(plan)).toEqual(plan)
  expect(() => parseNotebookFileRelocationPlan({ ...plan, entries: [plan.entries[0], plan.entries[0]] })).toThrow('duplicated')
  expect(() => parseNotebookFileRelocationPlan({ ...plan, entries: [{ noteId: 'same-id', suffix: '/../outside' }] })).toThrow()
  let state = emptyNotebookState()
  state = applyNotebookChange(state, { operationId: 'original-register', expectedRevision: state.revision, change: { kind: 'register', noteId: 'same-id', title: 'Original', resource: from } }, actor, 1)
  const before = structuredClone(state), rows = [{ noteId: 'same-id', from, to }, { noteId: 'same-id', from: { ...from, path: from.path + '/history' }, to: { ...to, path: to.path + '/history' } }]
  const expected = applyNotebookChange(state, { operationId: 'same-batch/note/0', expectedRevision: state.revision, change: { kind: 'relocate', noteId: 'same-id', from, resource: to } }, actor, 2)
  expect(applyNotebookFileRelocations(state, rows, 'same-batch', actor, 2)).toEqual(expected)
  expect(state).toEqual(before)
  await f.notes.apply({ operationId: 'register-cas', expectedRevision: 0, change: { kind: 'register', noteId: 'same-id', title: 'Original', resource: from } }, actor)
  const original = await f.notes.planFileRelocation(from, to)
  await f.notes.apply({ operationId: 'follow-before-publication', expectedRevision: (await f.notes.read()).revision, change: { kind: 'follow', noteId: 'same-id' } }, actor)
  await expect(f.notes.applyFileRelocation(original, 'stale-root', actor)).rejects.toMatchObject({ code: 'NOTE_METADATA_RELOCATION_CONFLICT' })
  expect((await f.notes.read()).pages['same-id']).toMatchObject({ title: 'Original', resource: from, followers: [{ actor }] })
})

it('original SDK freezes the complete Note relocation plan and actor before its first await and preserves CAS while queued', async () => {
  const f = await moveFixture(), actor = { kind: 'user' as const, id: 'original-queued-actor' }
  const from = { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root, path: 'source' }, to = { ...from, path: 'destination' }
  await f.notes.apply({ operationId: 'queue-register', expectedRevision: 0, change: { kind: 'register', noteId: 'queued-note', title: 'Original', resource: from } }, actor)
  const plan = await f.notes.planFileRelocation(from, to)
  let enter!: () => void, release!: () => void, latestRoot: string | null = null
  const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const held = f.notes.runWithWriteLease(async () => {
    await f.notes.apply({ operationId: 'queue-follow', expectedRevision: (await f.notes.read()).revision, change: { kind: 'follow', noteId: 'queued-note' } }, actor)
    latestRoot = (await f.notes.planFileRelocation(from, to)).root
    enter(); await gate
  })
  await entered
  let settled = false
  const queued = f.notes.applyFileRelocation(plan, 'must-retain-old-root', actor)
  void queued.then(() => { settled = true }, () => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  expect(settled).toBe(false)
  plan.root = latestRoot; plan.from.path = 'caller-edited'; plan.entries.length = 0; actor.id = 'later-actor'
  const rejected = expect(queued).rejects.toMatchObject({ code: 'NOTE_METADATA_RELOCATION_CONFLICT' })
  release(); await held; await rejected
  const unchanged = await f.notes.read()
  expect(unchanged.pages['queued-note']!.resource).toEqual(from)
  expect(unchanged.operations['must-retain-old-root/note/0']).toBeUndefined()
  const next = await f.notes.planFileRelocation(from, to), originalActor = { kind: 'user' as const, id: 'original-success-actor' }
  const success = f.notes.applyFileRelocation(next, 'queued-success', originalActor)
  originalActor.id = 'later-untrusted-edit'; next.to.path = 'caller-other-destination'
  await success
  const actual = await f.notes.read()
  expect(actual.pages['queued-note']!.resource).toEqual(to)
  expect(actual.trail.at(-1)).toMatchObject({ operationId: 'queued-success/note/0', actor: { kind: 'user', id: 'original-success-actor' } })
})
