// @vitest-environment node
import { appendFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { headlessFixture, until } from '../../../packages/core/test/helpers/headless-runtime-fixture.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state.js'
import { createWorkspaceLayout, createWorkbenchViewLayout } from '../../../packages/core/src/spatial-layout.js'

const cleanups: Array<() => Promise<void>> = []
const fact = (value: unknown) => { if (process.env.SESSION_EXECUTOR_FACTS) appendFileSync(process.env.SESSION_EXECUTOR_FACTS, JSON.stringify(value) + '\n') }
afterEach(async () => {
  const results = await Promise.allSettled(cleanups.splice(0).reverse().map(close => close()))
  expect(results.filter(value => value.status === 'rejected')).toEqual([])
  fact({ cleanup: 'confirmed', surface: 'default-host' })
})
it('session configuration reaches the default Host through original agent.open, RPC and CLI across Host restart', async () => {
  const loader = resolve(import.meta.dirname, 'session-executor-recovery-node-loader.mjs')
  const previous = process.env.AGENTMUX_TEST_OWNER_ENTRY
  process.env.AGENTMUX_TEST_OWNER_ENTRY = resolve(import.meta.dirname, 'fixtures/mobile-web-host.mjs')
  let f: Awaited<ReturnType<typeof headlessFixture>>
  try { f = await headlessFixture({ ownerNodeArgs: ['--experimental-transform-types', '--import', loader] }) }
  finally { if (previous === undefined) delete process.env.AGENTMUX_TEST_OWNER_ENTRY; else process.env.AGENTMUX_TEST_OWNER_ENTRY = previous }
  cleanups.push(async () => {
    try {
      const client = await f.client()
      for (const session of await client.readAgentSessions()) {
        const status = await client.statusAgent(session.agentSessionId)
        if (status.run.state === 'running') await client.stopAgent(session.agentSessionId, status.session.run)
      }
    } finally { await f.cleanup() }
  })
  const ownerOutput = { stdout: '', stderr: '' }
  for (const stream of ['stdout', 'stderr'] as const) f.ownerProcess[stream]?.on('data', value => { ownerOutput[stream] = (ownerOutput[stream] + String(value)).slice(-16 * 1024) })
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.socketPath } }); cleanups.push(() => rpc.dispose())
  let client = await f.client()
  const configurationPath = join(f.env.AGENTMUX_STATE_DIRECTORY!, 'original-configuration.json')
  const configuration = JSON.parse(await readFile(configurationPath, 'utf8'))
  const command = resolve(import.meta.dirname, '../../../packages/core/test/fixtures/fake-codex-cli.mjs')
  const retained = 'Original configuration native context'
  configuration.executors.codex = { providerId: 'codex', label: 'Private original Executor', command, args: [],
    env: { CODEX_HOME: join(f.root, 'home'), AGENTMUX_FAKE_READY_MODE: 'before', AGENTMUX_FAKE_NATIVE_RECORD: '1',
      AGENTMUX_FAKE_NATIVE_PRESERVE: '1', AGENTMUX_FAKE_NATIVE_RECORD_DIRECTORY: join(f.root, 'native'), AGENTMUX_FAKE_NATIVE_CONTEXT: retained }, injectAgentMuxGuide: false }
  await writeFile(configurationPath, JSON.stringify(configuration))
  const configurationBytes = await readFile(configurationPath, 'utf8')
  const inventory = await client.listHostExecutors()
  expect(inventory.executors.find(value => value.executorId === 'codex')?.source).toBe('provider-default')
  const spatial = new AgentMuxSpatialStateStore(join(f.env.AGENTMUX_STATE_DIRECTORY!, 'spatial-state.json'))
  const spaceId = 'original-space', zoneId = 'original-zone', tabId = 'original-tab', regionId = 'original-region'
  await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId, kind: 'folder', name: 'Original Workspace', hostId: 'local', directoryPath: f.root, projectId: spaceId }],
    zones: [{ zoneId, workspaceId: 'original-workspace', kind: 'directory', hostId: 'local', directoryPath: f.root, branch: null }],
    tabs: [{ tabId, zoneId, workspaceId: 'original-workspace', name: 'Original Tab', regionIds: [regionId] }],
    regions: [{ tabId, regionId, kind: 'launcher', agentSessionId: null, runId: null, execution: null }],
    bindings: [{ spaceId, zoneId }], layouts: { 'original-workspace': createWorkspaceLayout('original-group', [tabId]) },
    tabLayouts: { [tabId]: createWorkbenchViewLayout(regionId) }, resources: {} } })
  const opened = await rpc.call('agent.open', { operationId: 'original-configuration-create', content: { kind: 'new-agent', executorId: 'codex' }, destination: { spaceId, zoneId, tabId, regionId }, focus: false })
  expect(opened.outcome).toBe('opened')
  const sid = opened.agent!.agentSessionId
  const original = await until(() => client.statusAgent(sid), value => Boolean(value.session.nativeHandle), 'original native identity')
  expect(original.session.creation?.executorRevision).toBeUndefined()
  const { CtxmuxClient } = await import(/* @vite-ignore */ pathToFileURL(resolve(import.meta.dirname, '../../../packages/core/node_modules/@ctxmux/sdk/dist/index.js')).href)
  const socketPath = join(f.env.AGENTMUX_RUNTIME_DIRECTORY!, 'ctxmux.sock'), identity = await new CtxmuxClient({ socketPath }).runtimeInfo()
  expect(identity.daemonInstanceId).toBe(f.owner.ctxmux!.instanceId)
  const native = new CtxmuxClient({ socketPath, expectedRuntimeIdentity: identity })
  const exact = async (run: { runId: string }) => {
    const actual = await native.status(run.runId)
    expect(actual.spec.cwd).toBe(f.root); expect(actual.spec.args).toContain(command)
    expect(actual.spec.env.AGENTMUX_AGENT_SESSION_ID).toBe(sid)
    expect(actual.spec.env.AGENTMUX_FAKE_NATIVE_RECORD_DIRECTORY).toBe(join(f.root, 'native'))
    return actual
  }
  const firstRun = await exact(original.session.run)
  const end = async (run: { runId: string }) => {
    const actual = await exact(run); expect(actual.pid).toBeGreaterThan(1); expect(actual.pid).not.toBe(f.nativeProcessId)
    process.kill(actual.pid, 'SIGTERM')
    await until(() => native.status(run.runId), value => value.state.type === 'exited', 'exact private CLI exit')
  }
  await end(original.session.run)
  const resume = rpc.call('agent.resume', { target: { kind: 'agent-session', agentSessionId: sid }, operationId: 'original-configuration-rpc-resume', text: '' })
  try { await expect(resume).resolves.toMatchObject({ agentSessionId: sid }) }
  catch (error) {
    const observe = async (read: () => Promise<unknown>) => { try { return { state: 'observed', value: await read() } } catch (cause) { return { state: 'unknown', error: String(cause) } } }
    fact({ phase: 'public-resume-failure', operationId: 'original-configuration-rpc-resume', sid,
      owner: { pid: f.ownerProcess.pid, exitCode: f.ownerProcess.exitCode, signalCode: f.ownerProcess.signalCode, output: ownerOutput },
      original: await observe(() => client.statusAgent(sid)), identity: await observe(() => rpc.call('runtime.owner.identity', {})),
      error: error instanceof Error ? { name: error.name, message: error.message, cause: error.cause } : String(error) })
    throw error
  }
  const resumed = await resume
  expect(resumed.agentSessionId).toBe(sid)
  const rpcRun = await exact({ runId: resumed.runId })
  expect(rpcRun.spec.args).toContain('resume'); expect(rpcRun.spec.args).toContain(original.session.nativeHandle!.sessionId)
  await end({ runId: resumed.runId })
  const restart = await f.restart(); expect(restart.owner.runtimeId).toBe(f.owner.runtimeId)
  client = await f.client()
  const cli = await promisify(execFile)(process.execPath, ['--experimental-transform-types', '--import', loader,
    resolve(import.meta.dirname, '../../../packages/core/src/agentmux.ts'), '--endpoint', 'unix:' + f.socketPath,
    'agent', 'resume', '--session', sid, '--operation-id', 'original-configuration-cli-resume'], { env: f.env })
  const result = JSON.parse(cli.stdout).result
  expect(result.agentSessionId).toBe(sid)
  const final = await client.statusAgent(sid), cliRun = await exact(final.session.run)
  expect(cliRun.id).not.toBe(rpcRun.id); expect(final.session.nativeHandle).toEqual(original.session.nativeHandle)
  expect(final.session.workspacePath).toBe(original.session.workspacePath)
  const raw = await until(async () => (await client.readRunReplay(final.session.run)).replay.map(value => value.data).join(''), value => value.includes('codex-restored-context:'), 'fixture protocol retained context')
  const witness = JSON.parse(/codex-restored-context:([^\r\n]+)/u.exec(raw)![1]!)
  expect(witness.bodies).toContainEqual({ role: 'user', text: retained })
  expect(await readFile(configurationPath, 'utf8')).toBe(configurationBytes)
  expect((await client.listHostExecutors()).executors.find(value => value.executorId === 'codex')?.source).toBe('provider-default')
  expect((await client.readAgentSessions()).filter(value => value.creation?.createOperationId === 'original-configuration-create')).toHaveLength(1)
  const launch = (run: any) => ({ id: run.id, pid: run.pid, program: run.spec.program, args: run.spec.args, cwd: run.spec.cwd,
    agentSessionId: run.spec.env.AGENTMUX_AGENT_SESSION_ID, executorId: run.spec.env.AGENTMUX_EXECUTOR_ID,
    nativeRecordDirectory: run.spec.env.AGENTMUX_FAKE_NATIVE_RECORD_DIRECTORY, hookCredentialPresent: Boolean(run.spec.env.AGENTMUX_HOOK_TOKEN) })
  fact({ phase: 'default-host-original-configuration', sid, originalRun: launch(firstRun), rpcRun: launch(rpcRun), cliRun: launch(cliRun),
    nativeHandle: final.session.nativeHandle, publicRpc: resumed, cli: result, registrySource: 'provider-default', configurationUnchanged: true })
})
