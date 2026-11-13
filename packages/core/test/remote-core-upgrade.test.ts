import { PROTOCOL_VERSION } from '@ctxmux/sdk'
import { fixturePath } from './helpers/fixture-values.js'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ctxmuxOwnerReceiptPath } from '../src/runtime-paths.js'
import { RemoteCoreUpgradeManager, remoteCoreUpgradeTargetDigest, type RemoteCoreUpgradeHost } from '../src/remote-core-upgrade.js'
import { INSPECT_CORE_OWNER, READ_CORE_MAINTENANCE, OWNER_GONE, STAGE_CORE, START_CORE, NATIVE_RUN_INVENTORY } from '../src/remote-core-upgrade-programs.js'
import { parseRemoteCoreUpgradeCheck } from '../src/remote-core-upgrade-codec.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import type { AgentMuxAgentSession } from '../src/types.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true }))) })
const digest = 'a'.repeat(64), nativeDigest = 'b'.repeat(64)
const host: RemoteCoreUpgradeHost = { kind: 'ssh', id: 'original', label: 'Original', hostname: 'host.invalid', runtimeId: 'runtime', remoteCommand: fixturePath('original/bin/core-public'), remoteSocketPath: fixturePath("scope/runtime/control.sock") }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'core-upgrade-')); directories.push(root)
  const archivePath = join(root, 'archive.tar.gz'); await writeFile(archivePath, 'offline-candidate')
  const effects: string[] = []
  const native = { instanceId: 'native-original', processId: 202, buildIdentity: 'ctxmuxd/0.1.0', protocolVersion: PROTOCOL_VERSION }
  let owner = { runtimeId: 'runtime', ownerInstanceId: 'original', protocolVersion: 2 as const, processId: 101, ctxmux: native, availability: 'connected' as const }
  let launch = { node: fixturePath("original/bin/node"), cli: fixturePath("original/core/dist/headless-runtime-cli.js"), cwd: fixturePath("original/work"), processId: 101, startTicks: '1234',
    env: { HOME: fixturePath("scope/home"), PATH: fixturePath("original/bin:/usr/bin"), AGENTMUX_STATE_DIRECTORY: fixturePath("scope/state"), AGENTMUX_RUNTIME_DIRECTORY: fixturePath("scope/runtime"), AGENTMUX_AGENT_SESSION_STORE: fixturePath("scope/state/sessions.json") },
    stateDirectory: fixturePath("scope/state"), runtimeDirectory: fixturePath("scope/runtime"), storePath: fixturePath("scope/state/sessions.json"), nativeSha256: nativeDigest, nativeProcessId: 202, nativeStartTicks: '4321',
    nativeArtifactDirectory: fixturePath('original/core/vendor/ctxmux/linux-x64'), nativeManifestSha256: 'e'.repeat(64), nativeInstanceId: native.instanceId,
    nativeRuntimeId: 'native-runtime', nativeBuildId: native.buildIdentity, platform: 'linux-x64', deploymentDigest: 'd'.repeat(64), version: '0.1.0', sourceCommit: 'old-source' }
  const sessions = [{ agentSessionId: 'original-session', run: { runId: 'original-run' } }] as AgentMuxAgentSession[]
  let receiptStatus = 'matching', physicalDrift = false
  const physical = () => { const { nativeInstanceId, nativeRuntimeId, nativeBuildId, ...value } = launch; return value }
  let shutdownUnknown = false, startUnknown = false, changedWhileStaging = false, changedTerminal = false, naturalExit = false, savedRunMissing = false
  let stageCommand = fixturePath("scope/state/core-releases/") + digest + '/launcher/amux'
  let stagePause: Promise<void> | undefined, resumeStage: (() => void) | undefined
  const compatibility = { daemonInstanceId: native.instanceId, runtimeId: launch.nativeRuntimeId, protocolGeneration: PROTOCOL_VERSION,
    runtimeIdPersistence: 'state_dir', buildId: native.buildIdentity, platform: 'linux', arch: 'x86_64',
    capabilities: { 'native.start': 1, 'native.recoverable_input': 1, 'native.recoverable_stop': 1, 'services.persistent_state': 1, 'services.planned_exec_upgrade_continuity': 1 } }
  const maintenance = vi.fn(async params => {
    expect(params.runtimeId).toBe('runtime'); expect(params.socket).toBe(host.remoteSocketPath)
    const projectedOwner = { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId, processId: owner.processId, protocolVersion: owner.protocolVersion, ctxmux: native }
    if (params.shutdown) {
      expect(params.shutdown).toMatchObject({ ownerInstanceId: owner.ownerInstanceId, processId: owner.processId, sourceDigest: launch.deploymentDigest })
      effects.push('stop-original-core'); if (shutdownUnknown) throw new Error('shutdown response lost')
      return { owner: projectedOwner, accepted: true }
    }
    return { owner: projectedOwner, bootstrap: { storePath: launch.storePath, hostProcessId: owner.processId, sessions },
      runs: savedRunMissing ? [] : [{ agentSessionId: 'original-session', runId: 'original-run', pid: 404, state: 'running', outputBytes: owner.processId === 101 ? 100 : 120, inputBytes: 3 }],
      missingRunIds: savedRunMissing ? ['original-run'] : [],
      nativeRuntime: { ...compatibility, protocolGeneration: native.protocolVersion } }
  })
  const run = vi.fn(async (_command, args, options) => {
    const p = JSON.parse(options.input)
    let output: unknown
    if (args[1] === INSPECT_CORE_OWNER) {
      expect(p.socket).toBe(host.remoteSocketPath); expect(p.runtimeId).toBe('runtime'); if (p.pid) expect(p.pid).toBe(owner.processId)
      if (p.receipt) {
        expect(maintenance).toHaveBeenCalled()
        expect(p.receipt.identity).toEqual({ ...compatibility, protocolGeneration: native.protocolVersion })
        expect(p.receipt.path).toBe(ctxmuxOwnerReceiptPath(join(launch.runtimeDirectory, 'ctxmux.sock'), compatibility, launch.nativeManifestSha256))
      }
      output = { ...physical(), ...(p.receipt ? { nativeStartTicks: physicalDrift ? 'changed' : launch.nativeStartTicks, ownerReceipt: { status: receiptStatus, path: p.receipt.path } } : {}) }
    }
    else if (args[1] === READ_CORE_MAINTENANCE) { expect(_command).toBe(launch.node); expect(p.launch).toEqual(p.shutdown ? launch : physical()); output = await maintenance(p) }
    else if (args[1] === OWNER_GONE) output = { gone: true }
    else if (args[1] === NATIVE_RUN_INVENTORY) output = { instanceId: native.instanceId, protocolVersion: native.protocolVersion,
      runs: [...(savedRunMissing ? [] : [{ runId: 'original-run', pid: 404, state: 'running', outputBytes: owner.processId === 101 ? 100 : 120, inputBytes: 3 }]),
        { runId: 'ordinary-terminal', pid: owner.processId !== 101 && naturalExit ? null : owner.processId !== 101 && changedTerminal ? 506 : 505,
          state: owner.processId !== 101 && naturalExit ? 'exited' : 'running', outputBytes: 50, inputBytes: owner.processId !== 101 && naturalExit ? null : 6 }] }
    else if (args[1] === STAGE_CORE) {
      effects.push('stage-offline-candidate'); expect(p.stateDirectory).toBe(fixturePath("scope/state")); expect(p.node).toBe(fixturePath("original/bin/node"))
      await stagePause
      if (changedWhileStaging) owner = { ...owner, ownerInstanceId: 'replacement' }
      output = { releaseDirectory: fixturePath("scope/state/core-releases/") + digest, remoteCommand: stageCommand, digest }
    } else if (args[1] === START_CORE) {
      effects.push('start-new-core'); expect(p.env).toEqual(launch.env); expect(p.cwd).toBe(fixturePath("original/work"))
      owner = { ...owner, ownerInstanceId: 'updated', processId: 303 }
      launch = { ...launch, cli: fixturePath("scope/state/core-releases/") + digest + '/dist/headless-runtime-cli.js', processId: owner.processId, startTicks: '5555', deploymentDigest: digest }
      if (startUnknown) throw new Error('start response lost')
      output = { processId: owner.processId }
    } else throw new Error('Unexpected program')
    return { stdout: JSON.stringify(output), stderr: '', exitCode: 0 }
  })
  const options = { stateDirectory: root, artifact: async () => ({ digest, sourceCommit: 'source', version: '0.1.0', ownerProtocolVersion: 2, requiredNativeProtocolVersion: PROTOCOL_VERSION, nativeBuild: 'native-source', nativeDigest, archivePath,
    archiveDigest: createHash('sha256').update(await readFile(archivePath)).digest('hex'), files: [] }),
    executionHost: () => ({ id: 'original', kind: 'ssh' as const, label: 'Original', run, dispose: async () => {} }) }
  const manager = new RemoteCoreUpgradeManager(options)
  return { root, manager, options, effects, native, run, maintenance, sessions, compatibility,
    setReceiptStatus: (status: string) => { receiptStatus = status }, setPhysicalDrift: () => { physicalDrift = true },
    setOwnerProtocol: (version: number) => { owner = { ...owner, protocolVersion: version as 2 } },
    setCurrentDigest: (value: string) => { launch = { ...launch, deploymentDigest: value } },
    setStageCommand: (command: string) => { stageCommand = command },
    setShutdownUnknown: () => { shutdownUnknown = true }, setStartUnknown: () => { startUnknown = true }, setChangedWhileStaging: () => { changedWhileStaging = true },
    setChangedTerminal: () => { changedTerminal = true }, setNaturalExit: () => { naturalExit = true },
    setSavedRunMissing: () => { savedRunMissing = true },
    pauseStage: () => { stagePause = new Promise(resolve => { resumeStage = resolve }) }, resumeStage: () => resumeStage?.() }
}

it('performs one fenced Core update and preserves the original namespace, Session and Native owner', async () => {
  const f = await fixture(), check = await f.manager.check(host)
  expect(check.eligible).toBe(true); expect(check.expected).toBeDefined(); expect(f.effects).toEqual([])
  const receipt = await f.manager.upgrade(host, check.expected!, 'once')
  expect(receipt.status).toBe('completed'); expect(receipt.operationId).toBe('once')
  expect(receipt.remoteCommand).toBe(fixturePath("scope/state/core-releases/") + digest + '/launcher/amux')
  expect(receipt.input).toEqual(host)
  expect(f.effects).toEqual(['stage-offline-candidate', 'stop-original-core', 'start-new-core'])
  const again = await f.manager.upgrade(host, check.expected!, 'once')
  expect(again).toEqual(receipt); expect(f.effects).toHaveLength(3)
  expect((await f.manager.inspect({ ...host, remoteCommand: receipt.remoteCommand! }, 'once'))?.status).toBe('completed')
})

it.each(['native-pending', 'wrong-store'])('refuses only this unqualified remote update (%s) without stopping its owner or Runs', async shape => {
  const f = await fixture(), read = f.maintenance.getMockImplementation()!
  f.maintenance.mockImplementation(async (...args) => {
    const value = await read(...args)
    return shape === 'native-pending' ? { ...value, owner: { ...value.owner, ctxmux: null } }
      : { ...value, bootstrap: { ...value.bootstrap, storePath: fixturePath('another/store.json') } }
  })
  const check = await f.manager.check(host)
  expect(check).toMatchObject({ eligible: false, reason: 'unverified' })
  expect(check.expected).toBeUndefined()
  expect(f.effects).toEqual([])
  expect(f.maintenance).toHaveBeenCalledTimes(1)
  expect(f.run.mock.calls.every(([, args]) => args[1] === INSPECT_CORE_OWNER || args[1] === READ_CORE_MAINTENANCE)).toBe(true)
  expect(f.sessions).toMatchObject([{ agentSessionId: 'original-session', run: { runId: 'original-run' } }])
})

it('rejects a staging command outside the exact new launcher before stopping the owner', async () => {
  const f = await fixture(), check = await f.manager.check(host)
  f.setStageCommand(fixturePath("scope/state/core-releases/") + digest + '/bin/agentmux-public')
  const receipt = await f.manager.upgrade(host, check.expected!, 'wrong-launcher')
  expect(receipt).toMatchObject({ status: 'failed', stage: 'preparing' })
  expect(receipt.detail).toContain('staging receipt belongs to another artifact')
  expect(f.effects).toEqual(['stage-offline-candidate'])
})

it('inspects an old retained launcher path without migrating its receipt or repeating lifecycle', async () => {
  const f = await fixture(), check = await f.manager.check(host)
  await f.manager.upgrade(host, check.expected!, 'legacy-receipt')
  const path = join(f.root, 'operations', 'legacy-receipt.json')
  const retained = JSON.parse(await readFile(path, 'utf8'))
  const legacyCommand = fixturePath("scope/state/core-releases/") + digest + '/bin/agentmux-public'
  retained.receipt.remoteCommand = legacyCommand
  retained.receipt.status = 'unknown'
  await writeFile(path, JSON.stringify(retained))
  f.maintenance.mockClear()
  const restarted = new RemoteCoreUpgradeManager(f.options)
  const observed = await restarted.inspect(host, 'legacy-receipt')
  expect(observed).toMatchObject({ status: 'completed', remoteCommand: legacyCommand, input: host })
  expect(f.maintenance.mock.calls.length).toBeGreaterThan(0)
  expect(f.maintenance.mock.calls.every(([params]) => params.socket === host.remoteSocketPath)).toBe(true)
  expect(f.effects).toEqual(['stage-offline-candidate', 'stop-original-core', 'start-new-core'])
  expect(JSON.parse(await readFile(path, 'utf8')).receipt.remoteCommand).toBe(legacyCommand)
})

it('allows an explicit check after local artifact assembly failed and retains the successful candidate', async () => {
  const f = await fixture()
  const assemble = vi.fn(f.options.artifact).mockRejectedValueOnce(new Error('temporary local assembly failure'))
  const manager = new RemoteCoreUpgradeManager({ ...f.options, artifact: assemble })
  expect(await manager.check(host)).toMatchObject({ candidate: null, candidateUnavailable: { code: 'CORE_ARTIFACT_UNAVAILABLE', detail: 'temporary local assembly failure' },
    current: { state: 'available', version: '0.1.0' }, eligible: false, reason: 'unverified' })
  expect(f.effects).toEqual([]); expect(f.maintenance).toHaveBeenCalledOnce()
  expect((await manager.check(host)).eligible).toBe(true)
  expect((await manager.check(host)).eligible).toBe(true)
  expect(assemble).toHaveBeenCalledTimes(2); expect(f.effects).toEqual([])
})

it('qualifies the exact observed Native process when the normal owner DTO has no Native PID', async () => {
  const f = await fixture()
  f.native.processId = null as unknown as number
  const check = await f.manager.check(host)
  expect(check.eligible).toBe(true); expect(check.expected?.nativeProcessId).toBe(202)
  expect(check.expected?.nativeStartTicks).toBe('4321'); expect(f.effects).toEqual([])
})

it('refuses Native mismatch and stale owner without stopping any Core or Run', async () => {
  const f = await fixture(); f.native.protocolVersion = 21
  const unavailable = await f.manager.check(host)
  expect(unavailable.eligible).toBe(false); expect(unavailable.expected).toBeUndefined(); expect(unavailable.reason).toBe('runtime-update-required'); expect(f.effects).toEqual([])
  f.native.protocolVersion = PROTOCOL_VERSION
  const differentNative = new RemoteCoreUpgradeManager({ ...f.options, artifact: async () => ({ ...await f.options.artifact(), nativeDigest: 'c'.repeat(64) }) })
  expect(await differentNative.check(host)).toMatchObject({ eligible: true, reason: 'ready' })
  expect(f.effects).toEqual([])
  const check = await f.manager.check(host); f.setChangedWhileStaging()
  const receipt = await f.manager.upgrade(host, check.expected!, 'stale')
  expect(receipt.status).toBe('failed'); expect(f.effects).toEqual(['stage-offline-candidate'])
})

it.each(['runtimeIdPersistence', 'buildId', 'platform', 'arch', 'capabilities'] as const)('uses the current single Native contract for %s rather than candidate binary equality', async key => {
  const f = await fixture()
  if (key === 'capabilities') f.compatibility.capabilities['native.recoverable_input'] = 2
  else f.compatibility[key] = 'unqualified'
  expect(await f.manager.check(host)).toMatchObject({ eligible: false })
  expect(f.effects).toEqual([])
})

it('preserves the original saved Session binding when its exact Native Run is physically absent', async () => {
  const f = await fixture(); f.setSavedRunMissing()
  const check = await f.manager.check(host)
  expect(check.eligible, check.detail).toBe(true)
  const receipt = await f.manager.upgrade(host, check.expected!, 'missing-saved-run')
  expect(receipt.status, receipt.detail).toBe('completed')
  const retained = JSON.parse(await readFile(join(f.root, 'operations', 'missing-saved-run.json'), 'utf8'))
  expect(retained.observed.bootstrap.sessions).toEqual([{ agentSessionId: 'original-session', run: { runId: 'original-run' } }])
  expect(retained.observed.missingRunIds).toEqual(['original-run'])
  expect(retained.nativeRuns).toMatchObject([{ runId: 'ordinary-terminal', pid: 505, state: 'running' }])
  expect(f.effects).toEqual(['stage-offline-candidate', 'stop-original-core', 'start-new-core'])
})

it('retains an unknown shutdown, reads it after owner restart and rejects any automatic replay', async () => {
  const f = await fixture(), check = await f.manager.check(host); f.setShutdownUnknown()
  const receipt = await f.manager.upgrade(host, check.expected!, 'unknown-stop')
  expect(receipt.status).toBe('unknown'); expect(receipt.stage).toBe('stopping')
  const restarted = new RemoteCoreUpgradeManager(f.options)
  expect((await restarted.check(host)).latestOperation?.operationId).toBe('unknown-stop')
  expect((await restarted.check(host)).eligible).toBe(false)
  await restarted.upgrade(host, check.expected!, 'unknown-stop')
  await expect(restarted.upgrade(host, check.expected!, 'new-operation')).rejects.toThrow('unconfirmed')
  expect(f.effects).toEqual(['stage-offline-candidate', 'stop-original-core'])
})

it('reconciles a lost start response by reading the original deployed owner without starting it twice', async () => {
  const f = await fixture(), check = await f.manager.check(host); f.setStartUnknown()
  expect((await f.manager.upgrade(host, check.expected!, 'lost-start')).status).toBe('unknown')
  const restarted = new RemoteCoreUpgradeManager(f.options), inspected = await restarted.inspect(host, 'lost-start')
  expect(inspected?.status).toBe('completed'); expect(f.effects.filter(effect => effect === 'start-new-core')).toHaveLength(1)
})

it('binds the admission to its exact route while allowing a display-name edit', async () => {
  const f = await fixture(), check = await f.manager.check(host)
  expect(remoteCoreUpgradeTargetDigest({ ...host, label: 'Renamed' })).toBe(check.expected!.targetDigest)
  await expect(f.manager.upgrade({ ...host, hostname: 'another.invalid' }, check.expected!, 'wrong')).rejects.toThrow('changed')
  expect(f.effects).toEqual([])
})

it('two manager instances share one original admission and do not overwrite a running ledger', async () => {
  const f = await fixture(), check = await f.manager.check(host); f.pauseStage()
  const first = f.manager.upgrade(host, check.expected!, 'shared-admission')
  await vi.waitFor(() => expect(f.effects).toEqual(['stage-offline-candidate']))
  const other = new RemoteCoreUpgradeManager(f.options)
  expect((await other.inspect(host, 'shared-admission'))?.status).toBe('running')
  expect((await other.upgrade(host, check.expected!, 'shared-admission')).status).toBe('running')
  await expect(other.upgrade(host, check.expected!, 'second-operation')).rejects.toThrow('unconfirmed')
  expect((await f.manager.inspect(host, 'shared-admission'))?.status).toBe('running')
  f.resumeStage(); expect((await first).status).toBe('completed')
  expect(f.effects).toEqual(['stage-offline-candidate', 'stop-original-core', 'start-new-core'])
})

it('an unconfirmed operation remains discoverable even beside a newer closed observation', async () => {
  const f = await fixture(), check = await f.manager.check(host); f.setShutdownUnknown()
  const unknown = await f.manager.upgrade(host, check.expected!, 'unconfirmed')
  await writeFile(join(f.root, 'operations', 'closed.json'), JSON.stringify({ receipt: { ...unknown, operationId: 'closed', status: 'failed', updatedAt: unknown.updatedAt + 1000 } }))
  const other = new RemoteCoreUpgradeManager(f.options), next = await other.check(host)
  expect(next.latestOperation?.operationId).toBe('unconfirmed'); expect(next.eligible).toBe(false)
  await expect(other.upgrade(host, check.expected!, 'new-admission')).rejects.toThrow('unconfirmed')
  expect(f.effects).toEqual(['stage-offline-candidate', 'stop-original-core'])
})

it('checks ordinary terminal process continuity while allowing a terminal to exit naturally', async () => {
  const changed = await fixture(), pinned = await changed.manager.check(host); changed.setChangedTerminal()
  expect((await changed.manager.upgrade(host, pinned.expected!, 'lost-terminal')).status).toBe('unknown')
  const exited = await fixture(), eligible = await exited.manager.check(host); exited.setNaturalExit()
  expect((await exited.manager.upgrade(host, eligible.expected!, 'natural-exit')).status).toBe('completed')
})

it('a stale inspector cannot roll a completed operation back to unknown', async () => {
  const f = await fixture(), check = await f.manager.check(host); f.pauseStage()
  const first = f.manager.upgrade(host, check.expected!, 'final-race')
  await vi.waitFor(() => expect(f.effects).toEqual(['stage-offline-candidate']))
  const other = new RemoteCoreUpgradeManager(f.options)
  type Reader = { read(id: string): Promise<unknown> }
  const reader = other as unknown as Reader, original = reader.read.bind(other)
  let readSnapshot!: () => void, continueInspect!: () => void
  const read = new Promise<void>(resolve => { readSnapshot = resolve }), resume = new Promise<void>(resolve => { continueInspect = resolve })
  vi.spyOn(reader, 'read').mockImplementationOnce(async id => { const value = await original(id); readSnapshot(); await resume; return value })
  const inspecting = other.inspect(host, 'final-race')
  await read; f.resumeStage(); expect((await first).status).toBe('completed'); continueInspect()
  expect((await inspecting)?.status).toBe('completed')
  expect(JSON.parse(await readFile(join(f.root, 'operations', 'final-race.json'), 'utf8')).receipt.status).toBe('completed')
})

it('a route alias cannot bypass an unconfirmed operation on the same physical Core', async () => {
  const f = await fixture(), check = await f.manager.check(host); f.setShutdownUnknown()
  await f.manager.upgrade(host, check.expected!, 'original-route')
  const alias = { ...host, id: 'second-route', hostname: 'dns-alias.invalid', user: 'another-ssh-account', port: 2222, identityFile: fixturePath("other/identity") }
  const other = new RemoteCoreUpgradeManager(f.options)
  expect((await other.check(alias)).eligible).toBe(false)
  expect((await other.check(alias)).latestOperation).toMatchObject({ operationId: 'original-route', input: { id: host.id } })
  expect((await other.check(alias)).detail).toContain('original-route')
  await expect(other.upgrade(alias, { ...check.expected!, targetDigest: remoteCoreUpgradeTargetDigest(alias) }, 'alias-admission')).rejects.toThrow('original-route')
  expect(f.effects).toEqual(['stage-offline-candidate', 'stop-original-core'])
})

it.each(['missing', 'mismatch', 'unreadable'])('keeps qualified remote maintenance usable with %s product provenance', async status => {
  const f = await fixture(); f.setReceiptStatus(status)
  const check = await f.manager.check(host)
  expect(check.eligible).toBe(true); expect(check.detail).toContain('产品来源回执'); expect(f.effects).toEqual([])
  const receipt = await f.manager.upgrade(host, check.expected!, 'provenance-' + status)
  expect(receipt.status).toBe('completed')
  expect(f.effects).toEqual(['stage-offline-candidate', 'stop-original-core', 'start-new-core'])
})
it('refuses the exact remote maintenance when current process changes after public identity without touching Runs', async () => {
  const f = await fixture(); f.setPhysicalDrift()
  const check = await f.manager.check(host)
  expect(check.eligible).toBe(false); expect(check.detail).toContain('process or software changed'); expect(f.effects).toEqual([])
})

it('observes current version and separate owner/Native protocols despite incompatibility and an uncertain old operation', async () => {
  const f = await fixture(); f.setOwnerProtocol(1); f.native.protocolVersion = 21
  const incompatible = await f.manager.check(host)
  expect(incompatible).toMatchObject({ eligible: false, reason: 'runtime-update-required',
    current: { state: 'available', version: '0.1.0', sourceCommit: 'old-source', deploymentDigest: 'd'.repeat(64), ownerProtocolVersion: 1, native: { protocolVersion: 21 } },
    candidate: { version: '0.1.0', sourceCommit: 'source', digest, ownerProtocolVersion: 2, requiredNativeProtocolVersion: PROTOCOL_VERSION } })
  expect(f.effects).toEqual([])
  f.native.protocolVersion = PROTOCOL_VERSION
  const ready = await f.manager.check(host); f.setShutdownUnknown()
  const original = await f.manager.upgrade(host, ready.expected!, 'old-uncertain')
  const reading = await f.manager.check(host)
  expect(reading.current).toMatchObject({ state: 'available', version: '0.1.0', ownerProtocolVersion: 1 })
  expect(reading.latestOperation).toMatchObject({ operationId: original.operationId, status: 'unknown', candidate: { digest, ownerProtocolVersion: 2 } })
  expect(reading.eligible).toBe(false)
  expect(f.effects).toEqual(['stage-offline-candidate', 'stop-original-core'])
})

it('reports an identical content deployment as up-to-date and refuses mixed-owner check admissions', async () => {
  const f = await fixture(), ready = await f.manager.check(host)
  expect(parseRemoteCoreUpgradeCheck(ready)).toMatchObject({ eligible: true })
  for (const expected of [{ ...ready.expected!, ownerInstanceId: 'another-core' }, { ...ready.expected!, nativeInstanceId: 'another-native' }, { ...ready.expected!, runtimeId: 'another-runtime' }]) {
    expect(() => parseRemoteCoreUpgradeCheck({ ...ready, expected })).toThrow()
  }
  expect(() => parseRemoteCoreUpgradeCheck({ ...ready, current: { state: 'unavailable', observedAt: 1, code: 'UNAVAILABLE', detail: 'Unknown' } })).toThrow()
  f.setCurrentDigest(digest)
  expect(await f.manager.check(host)).toMatchObject({ eligible: false, reason: 'up-to-date', current: { state: 'available', deploymentDigest: digest } })
  expect(f.effects).toEqual([])
})

it('public SDK apply and original inspect retain a valid failed receipt when the reviewed candidate changed before admission', async () => {
  const f = await fixture(), checked = await f.manager.check(host)
  const replacement = new RemoteCoreUpgradeManager({ ...f.options, artifact: async () => ({ ...await f.options.artifact(), digest: 'f'.repeat(64) }) })
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'candidate-drift.sock'), coreClients: () => [], execute: async request => {
    if (request.operation === 'settings.hosts.upgrade') return { operation: request.operation, receipt: await replacement.upgrade(host, request.expected, request.requestId) }
    if (request.operation === 'settings.hosts.upgrade-inspect') return { operation: request.operation, receipt: await replacement.inspect(host, request.requestId) }
    throw new Error('Unexpected private operation')
  } })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  try {
    const result = await rpc.call('settings.hosts.upgrade', { id: host.id, expected: checked.expected!, operationId: 'reviewed-candidate' })
    expect(result.receipt).toMatchObject({ status: 'failed', operationId: 'reviewed-candidate', expected: { candidateDigest: digest } })
    expect(result.receipt?.candidate).toBeUndefined()
    const original = await rpc.call('settings.hosts.upgrade-inspect', { id: host.id, operationId: 'reviewed-candidate' })
    expect(original.receipt).toEqual(result.receipt)
    expect(f.effects).toEqual([])
  } finally { await rpc.dispose(); await server.stop() }
})

it.each(['same', 'different', 'unavailable', 'historical-without-summary'] as const)('original public SDK and compiled CLI reconcile the retained operation independently of %s current candidate', async variant => {
  const f = await fixture(), checked = await f.manager.check(host)
  f.setStartUnknown()
  const original = await f.manager.upgrade(host, checked.expected!, 'original-review')
  expect(original.status).toBe('unknown')
  if (variant === 'historical-without-summary') {
    // Model an original older App's persisted observation, rather than admitting
    // an incompatible Native through today's new-upgrade contract.
    const path = join(f.root, 'operations', original.operationId + '.json')
    const retained = JSON.parse(await readFile(path, 'utf8'))
    delete retained.receipt.candidate
    retained.observed.nativeRuntime.protocolGeneration = 21
    retained.observed.owner.ctxmux.protocolVersion = 21
    await writeFile(path, JSON.stringify(retained))
    f.native.protocolVersion = 21
  }
  const assemble = vi.fn(async () => {
    if (variant === 'unavailable') throw new Error('Current App candidate assembly unavailable')
    return { ...await f.options.artifact(), ...(variant === 'different' ? { digest: 'f'.repeat(64), requiredNativeProtocolVersion: 26, version: '2.0.0' } : {}) }
  })
  const reader = new RemoteCoreUpgradeManager({ ...f.options, artifact: assemble })
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'original-review.sock'), coreClients: () => [], execute: async request => {
    if (request.operation === 'settings.hosts.upgrade-inspect') return { operation: request.operation, receipt: await reader.inspect(host, request.requestId) }
    if (request.operation === 'settings.hosts.upgrade-check') return { operation: request.operation, check: await reader.check(host) }
    throw new Error('Unexpected private review operation')
  } })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  try {
    const inspected = await rpc.call('settings.hosts.upgrade-inspect', { id: host.id, operationId: original.operationId })
    expect(inspected.receipt).toMatchObject({ operationId: original.operationId, status: 'completed', expected: original.expected })
    expect(assemble).not.toHaveBeenCalled()
    expect(inspected.receipt?.candidate).toEqual(variant === 'historical-without-summary' ? undefined : original.candidate)
    const env = objectCliEnvironment(f.root, { AGENTMUX_RPC_ENDPOINT: 'unix:' + server.path })
    const checkedCli = await runCompiledObjectCli(['settings', 'hosts', 'upgrade-check', host.id], env)
    expect(checkedCli.code, checkedCli.stderr).toBe(0)
    const check = JSON.parse(checkedCli.stdout).result.check
    expect(check.current).toMatchObject({ state: 'available', runtimeId: 'runtime' })
    expect(check.latestOperation).toMatchObject({ operationId: original.operationId, status: 'completed', expected: original.expected })
    if (variant === 'unavailable') expect(check).toMatchObject({ candidate: null, candidateUnavailable: { code: 'CORE_ARTIFACT_UNAVAILABLE' }, eligible: false, reason: 'unverified' })
    if (variant === 'different') expect(check.candidate).toMatchObject({ digest: 'f'.repeat(64), requiredNativeProtocolVersion: 26 })
    const cli = await runCompiledObjectCli(['settings', 'hosts', 'upgrade-inspect', host.id, '--operation-id', original.operationId], env)
    expect(cli.code, cli.stderr).toBe(0)
    expect(JSON.parse(cli.stdout).result.receipt).toEqual(inspected.receipt)
    expect(assemble).toHaveBeenCalledOnce()
    expect(f.run.mock.calls.filter(([, args]) => args[1] === NATIVE_RUN_INVENTORY).every(([, , options]) => JSON.parse(options.input).releaseDirectory === fixturePath('scope/state/core-releases/') + digest)).toBe(true)
    expect(f.effects).toEqual(['stage-offline-candidate', 'stop-original-core', 'start-new-core'])
  } finally { await rpc.dispose(); await server.stop() }
}, 15_000)

it.each(['identity', 'native-contract', 'native-capability', 'candidate-contract', 'inventory-protocol', 'run', 'missing-contract'] as const)('retained operation inspection keeps conflicting or insufficient %s evidence unknown without replay', async shape => {
  const f = await fixture(), checked = await f.manager.check(host)
  f.setStartUnknown(); await f.manager.upgrade(host, checked.expected!, 'uncertain-original')
  if (shape === 'identity') f.native.instanceId = 'another-native'
  if (shape === 'native-contract') f.native.protocolVersion = 21
  if (shape === 'native-capability') f.compatibility.capabilities['native.recoverable_input'] = 2
  if (shape === 'run') f.setChangedTerminal()
  if (shape === 'missing-contract' || shape === 'candidate-contract') {
    const path = join(f.root, 'operations', 'uncertain-original.json'), retained = JSON.parse(await readFile(path, 'utf8'))
    if (shape === 'missing-contract') delete retained.observed.nativeRuntime
    else retained.receipt.candidate.requiredNativeProtocolVersion = 21
    await writeFile(path, JSON.stringify(retained))
  }
  if (shape === 'inventory-protocol') {
    const execute = f.run.getMockImplementation()!
    f.run.mockImplementation(async (...args) => {
      const result = await execute(...args)
      return args[1][1] === NATIVE_RUN_INVENTORY ? { ...result, stdout: JSON.stringify({ ...JSON.parse(result.stdout), protocolVersion: 21 }) } : result
    })
  }
  const assemble = vi.fn(async () => { throw new Error('Must not assemble a new candidate to inspect the original') })
  const inspected = await new RemoteCoreUpgradeManager({ ...f.options, artifact: assemble }).inspect(host, 'uncertain-original')
  expect(inspected).toMatchObject({ operationId: 'uncertain-original', status: 'unknown', expected: checked.expected })
  expect(assemble).not.toHaveBeenCalled()
  expect(f.effects).toEqual(['stage-offline-candidate', 'stop-original-core', 'start-new-core'])
})

it('first public CLI check discovers an unresolved operation and current owner despite a failed local candidate, without inventing an admission', async () => {
  const f = await fixture(), checked = await f.manager.check(host)
  f.setShutdownUnknown(); const original = await f.manager.upgrade(host, checked.expected!, 'discover-original')
  const artifact = vi.fn(async () => { throw new Error('Local candidate cannot be assembled') })
  const reader = new RemoteCoreUpgradeManager({ ...f.options, artifact })
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'first-check.sock'), coreClients: () => [], execute: async request => {
    if (request.operation === 'settings.hosts.upgrade-check') return { operation: request.operation, check: await reader.check(host) }
    if (request.operation === 'settings.hosts.upgrade-inspect') return { operation: request.operation, receipt: await reader.inspect(host, request.requestId) }
    throw new Error('Unexpected private first-check operation')
  } })
  await server.start()
  try {
    const env = objectCliEnvironment(f.root, { AGENTMUX_RPC_ENDPOINT: 'unix:' + server.path })
    const result = await runCompiledObjectCli(['settings', 'hosts', 'upgrade-check', host.id], env)
    expect(result.code, result.stderr).toBe(0)
    const check = JSON.parse(result.stdout).result.check
    expect(check).toMatchObject({ candidate: null, candidateUnavailable: { code: 'CORE_ARTIFACT_UNAVAILABLE', detail: 'Local candidate cannot be assembled' },
      current: { state: 'available', ownerInstanceId: 'original' }, latestOperation: { operationId: original.operationId, status: 'unknown' }, eligible: false, reason: 'unverified' })
    expect(check.expected).toBeUndefined()
    const inspect = await runCompiledObjectCli(['settings', 'hosts', 'upgrade-inspect', host.id, '--operation-id', check.latestOperation.operationId], env)
    expect(inspect.code, inspect.stderr).toBe(0)
    expect(JSON.parse(inspect.stdout).result.receipt).toMatchObject({ operationId: original.operationId, status: 'unknown' })
    expect(artifact).toHaveBeenCalledOnce()
    expect(f.effects).toEqual(['stage-offline-candidate', 'stop-original-core'])
  } finally { await server.stop() }
})

it('strict public check codec rejects mixed or admission-bearing unavailable candidate facts', async () => {
  const f = await fixture(), ready = await f.manager.check(host)
  const unavailable = { ...ready, candidate: null, candidateUnavailable: { code: 'CORE_ARTIFACT_UNAVAILABLE', detail: 'Unavailable local candidate' }, eligible: false, reason: 'unverified', expected: undefined }
  expect(parseRemoteCoreUpgradeCheck(unavailable)).toMatchObject({ candidate: null, current: { state: 'available' } })
  for (const invalid of [
    { ...unavailable, candidateUnavailable: undefined },
    { ...unavailable, candidateUnavailable: { detail: 'Missing code' } },
    { ...unavailable, eligible: true, reason: 'ready', expected: ready.expected },
    { ...unavailable, reason: 'up-to-date' },
    { ...unavailable, candidate: ready.candidate },
    { ...ready, candidateUnavailable: unavailable.candidateUnavailable }
  ]) expect(() => parseRemoteCoreUpgradeCheck(invalid)).toThrow()
})

it('public CLI checks an SSH Host that keeps an unused empty Tailcat target, and still rejects an empty one in use', async () => {
  const f = await fixture()
  const residual: RemoteCoreUpgradeHost = { ...host, transport: 'ssh', tailcat: { address: '', keyFile: '' } }
  expect(parseRemoteCoreUpgradeCheck(await f.manager.check(residual)).input).toEqual(residual)
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'tailcat-check.sock'), coreClients: () => [], execute: async request => {
    if (request.operation === 'settings.hosts.upgrade-check') return { operation: request.operation, check: await f.manager.check(residual) }
    throw new Error('Unexpected residual Tailcat operation')
  } })
  await server.start()
  try {
    const result = await runCompiledObjectCli(['settings', 'hosts', 'upgrade-check', host.id], objectCliEnvironment(f.root, { AGENTMUX_RPC_ENDPOINT: 'unix:' + server.path }))
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).result.check).toMatchObject({ input: { tailcat: { address: '', keyFile: '' } }, eligible: true, reason: 'ready', current: { state: 'available' } })
  } finally { await server.stop() }
  const used = await f.manager.check({ ...residual, transport: 'ssh-tailcat' })
  expect(() => parseRemoteCoreUpgradeCheck(used)).toThrow('Tailcat target is invalid')
})
