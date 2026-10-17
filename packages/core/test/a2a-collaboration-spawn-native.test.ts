import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import type { AgentMuxAgentSession } from '../src/types.js'

const entry = process.env.AGENTMUX_TEST_COLLABORATION_CORE
const cliEntry = process.env.AGENTMUX_TEST_COLLABORATION_CLI
if (process.env.AGENTMUX_TEST_COLLABORATION_SCOPE !== 'spawn' || !entry || !cliEntry)
  throw new Error('Run the spawn verifier against a fresh compiled candidate; no automatic build or stale artifact is accepted.')
const core = await import(/* @vite-ignore */ entry) as typeof import('../src/index.js')
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) { try { await close() } catch (error) { errors.push(error) } }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (errors.length) throw new AggregateError(errors, 'Private spawn qualification cleanup failed')
})
async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  const within = async (milliseconds: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([exited.then(() => true), new Promise<false>(yes => { timer = setTimeout(() => yes(false), milliseconds) })]) }
    finally { clearTimeout(timer) }
  }
  child.kill('SIGTERM')
  if (await within(3_000)) return
  child.kill('SIGKILL')
  if (!await within(3_000)) throw new Error('A private fixture child did not exit after SIGKILL.')
  throw new Error('A private fixture child required SIGKILL after its bounded SIGTERM deadline.')
}

it('fresh compiled CLI reads original parent/child relations after the real Core owner process restarts with its original Store and Native Runs', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'asq-'))), runtime = join(root, 'r'), state = join(root, 's')
  await Promise.all([mkdir(runtime, { mode: 0o700 }), mkdir(state, { mode: 0o700 })])
  const env = objectCliEnvironment(root, { AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: state,
    AGENTMUX_AGENT_SESSION_STORE: join(state, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(state, 'messages.ndjson'),
    AGENTMUX_TEST_COLLABORATION_CORE: entry, AGENTMUX_SPAWN_FIXTURE_ROOT: root })
  let daemon: ChildProcess | undefined, owner: ChildProcess | undefined
  let rpc: Awaited<ReturnType<typeof core.connectAgentMuxRpc>> | undefined
  let client: Awaited<ReturnType<typeof core.connectHostedAgentMux>> | undefined
  const actors: AgentMuxAgentSession[] = []
  cleanup.push(async () => {
    const failures: unknown[] = []
    const attempt = async (close: () => Promise<unknown>) => { try { await close() } catch (error) { failures.push(error) } }
    if (client) for (const actor of actors.slice().reverse()) {
      await attempt(() => client!.stopAgent(actor.agentSessionId, actor.run))
    }
    await attempt(async () => client?.dispose()); await attempt(async () => rpc?.dispose())
    await attempt(() => stop(owner)); await attempt(() => stop(daemon))
    // The controlled actors also observe removal of this private root, so failed
    // control cleanup cannot leave a test PTY process running after its namespace.
    await attempt(() => rm(root, { recursive: true, force: true }))
    if (failures.length) throw new AggregateError(failures, 'Private actors could not be retired cleanly')
  })
  const binary = resolve(import.meta.dirname, '../vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd')
  daemon = spawn(binary, ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'],
    { env, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  let daemonError = ''; daemon.stderr!.on('data', bytes => { daemonError += String(bytes) })
  await new Promise<void>((yes, no) => {
    const timer = setTimeout(() => no(new Error('Private Native readiness failed: ' + daemonError)), 10_000)
    daemon!.stdio[3]!.once('data', () => { clearTimeout(timer); yes() })
    daemon!.once('error', error => { clearTimeout(timer); no(error) })
    daemon!.once('exit', code => { clearTimeout(timer); no(new Error('Private Native exited ' + code + ': ' + daemonError)) })
  })
  const nativePid = daemon.pid
  const startOwner = async () => {
    owner = spawn(process.execPath, [resolve(import.meta.dirname, 'fixtures/a2a-spawn/owner.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    owner.stdout!.on('data', bytes => { stdout += String(bytes) }); owner.stderr!.on('data', bytes => { stderr += String(bytes) })
    await vi.waitFor(() => { expect(owner!.exitCode, stderr).toBeNull(); expect(stdout, stderr).toContain('\n') }, { timeout: 10_000 })
    const identity = JSON.parse(stdout.split('\n')[0]!) as { processId: number; socketPath: string; owner: { runtimeId: string; ownerInstanceId: string } }
    expect(identity.processId).toBe(owner.pid)
    rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: identity.socketPath } })
    client = await core.connectHostedAgentMux({ rpc }); await client.connect()
    return identity
  }
  const firstOwner = await startOwner()
  const parent = await client!.createAgentWithDelivery({ agentSessionId: 'parent', createOperationId: 'original-parent', providerId: 'spawn-process',
    executorId: 'controlled-process', workspacePath: root, injectAgentMuxGuide: false })
  actors.push(parent.session)
  type Actor = { agentSessionId: string; capability: string; pid: number; prompt: string }
  const actor = async (sid: string) => JSON.parse(await readFile(join(root, sid + '.json'), 'utf8')) as Actor
  await vi.waitFor(async () => expect((await actor('parent')).agentSessionId).toBe('parent'))
  const parentActor = await actor('parent')
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', cliEntry)
  const cli = async (args: string[], author = parentActor) => {
    const result = await runCompiledObjectCli(args, { ...env, AGENTMUX_RPC_ENDPOINT: 'unix://' + firstOwner.socketPath,
      AGENTMUX_AGENT_SESSION_ID: author.agentSessionId, AGENTMUX_AGENT_CAPABILITY: author.capability })
    expect(result.code, result.stdout + result.stderr).toBe(0)
    return JSON.parse(result.stdout).result
  }
  const original = { executorId: 'controlled-process', text: 'Original authorized child task', operationId: 'original-child-spawn' }
  const discussionArgs = ['agent', 'discuss', '--agent', original.executorId, '--provider', 'spawn-process', '--text', original.text, '--operation-id', original.operationId]
  const discussion = await cli(discussionArgs)
  const child = await client!.readAgentSession(discussion.targetAgentSessionId)
  if (!child) throw new Error('Original child metadata was not retained')
  actors.push(child)
  await vi.waitFor(async () => expect((await actor(child.agentSessionId)).agentSessionId).toBe(child.agentSessionId))
  const childActor = await actor(child.agentSessionId)
  const createdBy = { agentSessionId: 'parent', run: parent.session.run, owner: { kind: 'local' } }
  expect(discussion.creation).toMatchObject({ createdBy, createdRun: child.run, initialMessageId: expect.any(String) })
  expect(childActor.prompt).toContain(original.text)
  expect(childActor.prompt).toContain('created by AgentMux Session parent')
  const created = await cli(['agent', 'spawn', 'ls', '--host', 'local', '--session', 'parent', '--direction', 'created'])
  expect(created.records).toHaveLength(1)
  expect(created.records[0]).toMatchObject({ agentSessionId: child.agentSessionId, creation: { createdBy, createdRun: child.run } })
  expect((await cli(['agent', 'spawn', 'ls', '--host', 'local', '--session', child.agentSessionId, '--direction', 'creator'], childActor)).records).toEqual(created.records)
  const reopened = new core.AgentMuxFileAgentSessionStore(env.AGENTMUX_AGENT_SESSION_STORE!)
  expect((await reopened.readMetadata(child.agentSessionId))?.creation?.createdBy).toEqual(createdBy)
  expect((await reopened.listSpawns({ participantSessionId: 'parent', direction: 'created' })).records).toEqual(created.records)
  await client!.dispose(); await rpc!.dispose(); client = undefined; rpc = undefined
  await stop(owner); expect(owner!.exitCode).toBe(0)
  expect(daemon.exitCode).toBeNull(); expect(daemon.pid).toBe(nativePid)
  const nextOwner = await startOwner()
  expect(nextOwner.socketPath).toBe(firstOwner.socketPath)
  expect(nextOwner.processId).not.toBe(firstOwner.processId)
  expect(nextOwner.owner.runtimeId).toBe(firstOwner.owner.runtimeId)
  expect(nextOwner.owner.ownerInstanceId).not.toBe(firstOwner.owner.ownerInstanceId)
  for (const value of actors) {
    expect((await client!.readAgentSession(value.agentSessionId))?.run).toEqual(value.run)
    expect((await client!.statusAgent(value.agentSessionId)).run.state).toBe('running')
  }
  expect(await actor('parent')).toEqual(parentActor); expect(await actor(child.agentSessionId)).toEqual(childActor)
  expect((await cli(['agent', 'spawn', 'ls', '--host', 'local', '--session', 'parent', '--direction', 'created'])).records).toEqual(created.records)
  expect((await cli(['whoami'], childActor)).session.creation).toEqual(child.creation)
  expect((await cli(discussionArgs)).targetAgentSessionId).toBe(child.agentSessionId)
  expect((await client!.listRuns()).filter(run => run.state === 'running')).toHaveLength(2)
  await client!.writeAgent({ agentSessionId: child.agentSessionId, expectedRun: child.run, source: 'user', data: 'still-working' })
  await vi.waitFor(async () => expect((await client!.readRunReplay(child.run)).replay.map(chunk => chunk.data).join('')).toContain('INPUT:still-working'))
}, 45_000)
