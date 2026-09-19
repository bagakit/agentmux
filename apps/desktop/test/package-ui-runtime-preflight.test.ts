import { afterAll, beforeAll, expect, it } from 'vitest'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DesktopClientObservation } from '../src/shared/client-observation'

const exec = promisify(execFile)
const repository = resolve(import.meta.dirname, '../../..')
const corePath = process.env.AGENTMUX_PREFLIGHT_CORE_PATH ?? join(repository, 'packages/core')
const vendor = join(corePath, 'vendor/ctxmux', `${process.platform}-${process.arch}`)
const installerPath = resolve(import.meta.dirname, '../scripts/package-runtime-upgrade.mjs')
// Real product helpers and packed SDK are loaded by their actual file paths.
// This owns Native metadata/preflight, not Renderer rendering or GUI cutover.
const installer = await import(pathToFileURL(installerPath).href)
let root: string, runtimeDirectory: string, socket: string, current: string, candidate: string
let daemon: ChildProcess, sdk: any, creator: any, runtime: any, observation: DesktopClientObservation
let agent: any, terminal: any, unrelated: any
const plans: any[] = []
const ownedRuns: any[] = []
const records: Record<string, unknown>[] = []
const oldRuntimeDirectory = process.env.AGENTMUX_RUNTIME_DIRECTORY
const oldStateDirectory = process.env.AGENTMUX_STATE_DIRECTORY
const oldQueue = process.env.AGENTMUX_MESSAGE_QUEUE_PATH
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
async function wait<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000
  do { const value = await read(); if (predicate(value)) return value; await new Promise(done => setTimeout(done, 20)) } while (Date.now() < deadline)
  throw new Error('Owned private fixture predicate did not settle')
}
async function settled<T>(read: () => Promise<T>): Promise<{ status: 'ok'; value: T } | { status: 'error'; message: string }> {
  try { return { status: 'ok', value: await read() } } catch (error) { return { status: 'error', message: String(error) } }
}
async function prepare(value: DesktopClientObservation | null = observation): Promise<any> {
  const plan = await installer.prepareUiRuntime(current, candidate, value)
  plans.push(plan)
  return plan
}
async function app(path: string): Promise<void> {
  const core = join(path, 'Contents/Resources/app/node_modules/@agentmux/core')
  await mkdir(join(core, 'dist'), { recursive: true })
  await writeFile(join(core, 'package.json'), JSON.stringify({ type: 'module' }))
  await symlink(join(corePath, 'vendor'), join(core, 'vendor'), 'dir')
  await writeFile(join(core, 'dist/index.js'), `export { assertAgentMuxRuntimeCompatibility } from ${JSON.stringify(pathToFileURL(join(corePath, 'dist/index.js')).href)};`)
  await writeFile(join(core, 'dist/runtime-paths.js'), `export const defaultCtxmuxSocketPath=()=>${JSON.stringify(socket)};export const defaultCtxmuxStateDirectory=()=>${JSON.stringify(join(runtimeDirectory, 'state', 'ctxmux'))};`)
}
function launchDaemon(): Promise<void> {
  daemon = spawn(join(vendor, 'bin/ctxmuxd'), ['--socket', socket, '--state-dir', join(runtimeDirectory, 'state', 'ctxmux'), '--readiness-fd', '3'],
    { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  daemon.stderr!.on('data', bytes => records.push({ stderr: String(bytes).slice(0, 1024) }))
  return new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Private Native readiness failed')), 5000)
    daemon.stdio[3]!.once('data', () => { clearTimeout(timer); done() })
    daemon.once('error', error => { clearTimeout(timer); reject(error) })
    daemon.once('exit', () => { clearTimeout(timer); reject(new Error('Private Native exited before ready')) })
  })
}
async function stopDaemon(): Promise<void> {
  if (daemon?.pid && daemon.exitCode === null && daemon.signalCode === null) {
    daemon.kill('SIGINT')
    await wait(async () => daemon.exitCode !== null || daemon.signalCode !== null, Boolean)
  }
  expect(daemon.exitCode).toBe(0)
  expect(daemon.signalCode).toBeNull()
}

beforeAll(async () => {
  root = await mkdtemp('/tmp/amx-uipre-')
  runtimeDirectory = join(root, 'runtime'); socket = join(runtimeDirectory, 'ctxmux.sock')
  await mkdir(runtimeDirectory); await mkdir(join(root, 'codex'))
  process.env.AGENTMUX_RUNTIME_DIRECTORY = runtimeDirectory
  process.env.AGENTMUX_STATE_DIRECTORY = join(runtimeDirectory, 'state')
  process.env.AGENTMUX_MESSAGE_QUEUE_PATH = join(root, 'messages.jsonl')
  const unpacked = join(root, 'sdk'); await mkdir(unpacked)
  await exec('/usr/bin/tar', ['-xzf', join(vendor, 'ctxmux-sdk-0.0.0.tgz'), '-C', unpacked])
  const api = await import(pathToFileURL(join(unpacked, 'package/dist/index.js')).href)
  sdk = new api.CtxmuxClient({ socketPath: socket })
  await launchDaemon(); runtime = await sdk.runtimeInfo()
  const core = await import(pathToFileURL(join(corePath, 'dist/index.js')).href)
  creator = await core.connectLocalAgentMux({ store: new core.AgentMuxFileAgentSessionStore(join(root, 'agent-sessions.json')) })
  const executable = join(root, 'agent.sh')
  await writeFile(executable, '#!/bin/sh\nif [ "$1" = --version ]; then echo "codex-cli 0.159.2"; exit 0; fi\nstty -echo -icanon\nprintf "PRIVATE AGENT READY\\r\\n"\nexec /bin/cat\n', { mode: 0o700 })
  const session = await creator.createAgent({ createOperationId: randomUUID(), executorId: 'private-agent', providerId: 'codex', commandOverride: executable,
    workspacePath: root, env: { CODEX_HOME: join(root, 'codex') }, injectAgentMuxGuide: false, cols: 80, rows: 24 })
  agent = await sdk.status(session.run.runId); ownedRuns.push(agent)
  terminal = await sdk.start(api.defineRun('/bin/cat', { cwd: root, env: {}, initialSize: { cols: 80, rows: 24 } })); ownedRuns.push(terminal)
  unrelated = await sdk.start(api.defineRun('/bin/cat', { cwd: root, env: {}, initialSize: { cols: 80, rows: 24 } })); ownedRuns.push(unrelated)
  const historyId = randomUUID()
  const region = (kind: 'agent' | 'terminal', id: string, runId: string, processState: 'running' | 'interrupted', hostId = 'local') => ({
    kind, regionId: id, workspaceId: 'workspace', sessionId: id, phase: 'attached' as const, processState,
    control: kind === 'agent' ? { kind, hostId, agentSessionId: id, run: { runId } } : { kind, hostId, runId, run: { runId } }
  })
  observation = { schema: 'agentmux.desktop-client-observation.v1', main: { pid: process.pid, package: null,
    renderer: { kind: 'bundled', id: 'a'.repeat(64), identity: { shell: 'fixture', ctxmux: 'fixture' } }, runtimes: [{ hostId: 'local', identity: {
      hostId: 'local', buildIdentity: runtime.buildId, protocolVersion: runtime.protocolGeneration, processId: daemon.pid!, instanceId: runtime.daemonInstanceId, ownership: 'unverified'
    } }] }, workbench: { loading: false, startupProgress: { step: 'layout' }, activeWorkspaceId: 'workspace', mainSurface: 'workbench',
    focus: { executionSessionId: 'agent-region', pmoSessionId: null }, tabs: [
      { id: 'live-tab', workspaceId: 'workspace', titleRegionId: 'agent-region', layout: { activeRegionId: 'agent-region', root: {
        type: 'split', direction: 'horizontal', ratio: 0.6, first: { type: 'leaf', regionId: 'agent-region' }, second: {
          type: 'split', direction: 'vertical', ratio: 0.4, first: { type: 'leaf', regionId: 'terminal-region' }, second: { type: 'leaf', regionId: 'browser-region' }
        } } }, regions: [region('agent', 'agent-region', agent.id, 'interrupted'), region('terminal', 'terminal-region', terminal.id, 'running'),
          { kind: 'browser', regionId: 'browser-region', workspaceId: 'workspace', browserId: 'browser', url: 'https://example.invalid/private', title: 'Private Browser', profileId: 'profile', navigationId: 'navigation', error: null, loading: false }] },
      { id: 'history-tab', workspaceId: 'workspace', titleRegionId: 'history-region', layout: { activeRegionId: 'history-region', root: {
        type: 'split', direction: 'vertical', ratio: 0.5, first: { type: 'leaf', regionId: 'history-region' }, second: { type: 'leaf', regionId: 'remote-region' }
      } }, regions: [region('agent', 'history-region', historyId, 'running'), region('agent', 'remote-region', unrelated.id, 'running', 'remote')] }
    ], layouts: { workspace: { activeGroupId: 'first', root: { type: 'split', direction: 'horizontal', ratio: 0.7, first: { type: 'leaf', groupId: 'first' }, second: { type: 'leaf', groupId: 'second' } },
      groups: [{ id: 'first', activeTabId: 'live-tab', tabOrder: ['live-tab'], recentTabIds: ['live-tab'] }, { id: 'second', activeTabId: 'history-tab', tabOrder: ['history-tab'], recentTabIds: ['history-tab'] }] } } } } as DesktopClientObservation
  current = join(root, 'current.app'); candidate = join(root, 'candidate.app')
  await app(current); await app(candidate)
  records.push({ daemon: daemon.pid, agent: { id: agent.id, pid: agent.pid }, terminal: { id: terminal.id, pid: terminal.pid }, historyId, unrelated: unrelated.id })
}, 20000)

afterAll(async () => {
  const errors: string[] = []
  for (const plan of plans) await installer.closeRuntimeUpgrade(plan).catch((error: Error) => errors.push(error.message))
  await creator?.dispose().catch((error: Error) => errors.push(error.message))
  for (const run of ownedRuns) {
    if (!daemon || daemon.exitCode !== null || daemon.signalCode !== null) break
    try {
      const currentRun = await sdk.status(run.id)
      if (currentRun.state.type === 'running') await sdk.stop(await sdk.prepareStop(run.id))
    } catch (error: any) { if (error.code !== 'run_not_found') errors.push(String(error)) }
  }
  if (daemon) await stopDaemon().catch(error => errors.push(String(error)))
  for (const run of ownedRuns) if (alive(run.pid)) errors.push(`Owned private child remains: ${run.pid}`)
  if (oldRuntimeDirectory === undefined) delete process.env.AGENTMUX_RUNTIME_DIRECTORY; else process.env.AGENTMUX_RUNTIME_DIRECTORY = oldRuntimeDirectory
  if (oldStateDirectory === undefined) delete process.env.AGENTMUX_STATE_DIRECTORY; else process.env.AGENTMUX_STATE_DIRECTORY = oldStateDirectory
  if (oldQueue === undefined) delete process.env.AGENTMUX_MESSAGE_QUEUE_PATH; else process.env.AGENTMUX_MESSAGE_QUEUE_PATH = oldQueue
  records.push({ cleanupErrors: errors, nativeSignalsDuringPreflight: 0, userRuntimeTouched: false })
  if (process.env.AGENTMUX_PREFLIGHT_PROOF_LOG) await writeFile(process.env.AGENTMUX_PREFLIGHT_PROOF_LOG, JSON.stringify(records, null, 2) + '\n')
  expect(errors).toEqual([])
  if (root) await rm(root, { recursive: true, force: true })
}, 20000)

it('protects exact current Native Agent and generic Run while retaining missing history and every workface fact', async () => {
  const original = structuredClone(observation)
  const result = await settled(() => prepare())
  expect(result.status).toBe('ok')
  if (result.status !== 'ok') throw new Error(result.message)
  const plan = result.value
  expect(plan.before.running.map((run: any) => [run.id, run.pid]).sort()).toEqual([[agent.id, agent.pid], [terminal.id, terminal.pid]].sort())
  expect(observation).toEqual(original)
  expect(observation.workbench.tabs[1]!.regions.map(value => value.regionId)).toEqual(['history-region', 'remote-region'])
  const confirmed = await installer.confirmUiRuntime(plan)
  expect(confirmed.originalRuns.map((run: any) => [run.id, run.pid]).sort()).toEqual([[agent.id, agent.pid], [terminal.id, terminal.pid]].sort())
  expect(confirmed.runtime).toEqual(runtime)
  records.push({ preflight: 'ok', pins: plan.before.running, confirmation: confirmed, workfaceUnchanged: true })
})

it('does not invent an outgoing workface baseline for a cold compatible listener', async () => {
  const plan = await prepare(null)
  expect(plan.before.running).toEqual([])
  expect(plan.before.runtime).toEqual(runtime)
  expect((await installer.confirmUiRuntime(plan)).originalRuns).toEqual([])
})

it('keeps exact PID and byte-cursor preservation checks strict', async () => {
  const plan = await prepare()
  const changed = (values: Record<string, unknown>) => ({ ...plan, before: { ...plan.before, running: plan.before.running.map((run: any) => run.id === agent.id ? { ...run, ...values } : run) } })
  const wrongPid = await settled(() => installer.confirmUiRuntime(changed({ pid: agent.pid + 1 })))
  expect(wrongPid.status).toBe('error')
  const wrongCursor = await settled(() => installer.confirmUiRuntime(changed({ acceptedInputBytes: agent.applied_input_bytes + 1000000 })))
  expect(wrongCursor.status).toBe('error')
  records.push({ wrongPid, wrongCursor })
})

it('rejects a confirmed original live Run that subsequently disappears', async () => {
  const plan = await prepare()
  await sdk.stop(await sdk.prepareStop(terminal.id))
  await wait(() => sdk.status(terminal.id), (run: any) => run.state.type === 'exited')
  await sdk.remove(terminal.id)
  const missing = await settled(() => installer.confirmUiRuntime(plan))
  expect(missing.status).toBe('error')
  expect(missing.status === 'error' ? missing.message : '').toContain('run_not_found')
  records.push({ currentLiveMissing: missing })
})

it('rejects the actual replacement daemon instance and preserves ordinary read failures', async () => {
  const plan = await prepare()
  // A changed retained instance is independent of Run health. All exact Run
  // facts still match this real listener, so another fence cannot mask this one.
  const mismatched = { ...plan, before: { ...plan.before,
    runtime: { ...plan.before.runtime, daemonInstanceId: randomUUID() } } }
  const instanceMismatch = await settled(() => installer.confirmUiRuntime(mismatched))
  expect(instanceMismatch.status).toBe('error')
  expect((await sdk.status(agent.id)).pid).toBe(agent.pid)
  records.push({ retainedInstanceMismatch: instanceMismatch, liveRunStillSame: agent.id,
    boundary: 'Synthetic retained identity mismatch; confirmation reads real healthy Native Runs.' })
  await creator.dispose(); creator = null
  await stopDaemon(); await launchDaemon()
  const replacement = await sdk.runtimeInfo()
  expect(replacement.runtimeId).toBe(runtime.runtimeId)
  expect(replacement.daemonInstanceId).not.toBe(runtime.daemonInstanceId)
  const changed = await settled(() => installer.confirmUiRuntime(plan))
  expect(changed.status).toBe('error')
  expect(changed.status === 'error' ? changed.message : '').toContain('Runtime/daemon identity changed')
  await stopDaemon()
  const unavailable = await settled(() => prepare())
  expect(unavailable.status).toBe('error')
  expect(unavailable.status === 'error' ? unavailable.message : '').toContain('listener is unavailable or unknown')
  records.push({ changedInstance: changed, actualListenerReadFailure: unavailable })
}, 15000)
