import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as core from '@agentmux/core'
import { headlessFixture, until } from '../../../packages/core/test/helpers/headless-runtime-fixture.js'
import { runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { spawnOwnerFixture } from '../../../packages/core/test/helpers/a2a-spawn-owner.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { AgentMuxHostExecutorOwner } from '../../../packages/core/src/executor-owner.js'
import type { AgentExecutorConfig } from '@agentmux/core'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks()
  if (errors.length) throw new AggregateError(errors, 'Private Host unregister cleanup failed')
})
const config = (command = process.execPath, env: Record<string, string> = {}): AgentExecutorConfig => ({ label: 'Private registered command', providerId: 'codex', command, args: [], env, injectAgentMuxGuide: false })
async function product() {
  await mkdir(resolve('apps/host/.tmp'), { recursive: true })
  const directory = await mkdtemp(resolve('apps/host/.tmp/unregister-host-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const { build } = await import(pathToFileURL(createRequire(resolve('apps/host/package.json')).resolve('esbuild')).href)
  const entry = join(directory, 'worker.mjs')
  // Production Host composition, bundled like the original Host producer; no fake export
  // or source-loader remapping of Core/client-ui. CLI still consumes real Core dist.
  const result = await build({ entryPoints: [resolve('apps/host/test/fixtures/host-executor-unregister-worker.mjs')], outfile: entry,
    bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24', metafile: true })
  expect(Object.keys(result.metafile.inputs)).toContain('apps/host/src/host.ts')
  const previous = process.env.AGENTMUX_TEST_OWNER_ENTRY
  process.env.AGENTMUX_TEST_OWNER_ENTRY = entry
  let f: Awaited<ReturnType<typeof headlessFixture>>
  try { f = await headlessFixture() } finally { if (previous === undefined) delete process.env.AGENTMUX_TEST_OWNER_ENTRY; else process.env.AGENTMUX_TEST_OWNER_ENTRY = previous }
  cleanup.push(() => f.cleanup())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.socketPath } }); cleanup.push(() => rpc.dispose())
  const cli = (args: string[], input?: unknown) => runCompiledObjectCli(['settings', 'executors', ...args], { ...f.env, AGENTMUX_RPC_ENDPOINT: 'unix:' + f.socketPath }, input === undefined ? '' : JSON.stringify(input))
  const register = async (id: string, value = config()) => {
    const result = await cli(['register', id, '--host', 'local', '--input', '-'], { config: value })
    expect(result.code, result.stderr).toBe(0)
    return (JSON.parse(result.stdout).result as core.HostSettingsResultMap['settings.executors.register']).executor
  }
  const remove = (id: string, revision: string) => cli(['unregister', id, '--host', 'local', '--registration-revision', revision])
  return { f, rpc, cli, register, remove }
}

it('actual Host and compiled CLI preserve publication generation across identical-config ABA and a private owner OS restart', async () => {
  const h = await product(), original = config(process.execPath, { SECRET_ORIGINAL: 'not-returned' })
  const first = await h.register('aba', original)
  expect(first.source).toBe('registered'); expect(first.registrationRevision).toBeTruthy()
  expect((await h.register('aba', original)).registrationRevision).toBe(first.registrationRevision)
  const removed = await h.remove('aba', first.registrationRevision!)
  expect(removed.code, removed.stderr).toBe(0)
  expect(JSON.parse(removed.stdout).result).toMatchObject({ removedRegistration: true, registrationRevision: first.registrationRevision, effectiveExecutor: null })
  const second = await h.register('aba', original)
  expect(second.configRevision).toBe(first.configRevision)
  expect(second.registrationRevision).not.toBe(first.registrationRevision)
  const stale = await h.remove('aba', first.registrationRevision!)
  expect(stale.code).not.toBe(0); expect(JSON.parse(stale.stderr).error.code).toBe('EXECUTOR_REGISTRATION_CONFLICT')
  const before = h.f.ownerProcess.pid
  await h.rpc.dispose(); await h.f.restart(); expect(h.f.ownerProcess.pid).not.toBe(before)
  const staleAfterRestart = await h.remove('aba', first.registrationRevision!)
  expect(staleAfterRestart.code).not.toBe(0); expect(JSON.parse(staleAfterRestart.stderr).error.code).toBe('EXECUTOR_REGISTRATION_CONFLICT')
  const observed = await h.cli(['discover', '--host', 'local'])
  expect(observed.code, observed.stderr).toBe(0)
  expect(observed.stdout).not.toContain('SECRET_ORIGINAL'); expect(observed.stdout).not.toContain('not-returned')
  expect(JSON.parse(observed.stdout).result.executors.find((d: core.AgentMuxHostExecutorDescriptor) => d.executorId === 'aba').registrationRevision).toBe(second.registrationRevision)
  expect((await h.remove('aba', second.registrationRevision!)).code).toBe(0)
  const override = await h.register('codex')
  const reveal = await h.remove('codex', override.registrationRevision!)
  expect(reveal.code, reveal.stderr).toBe(0)
  expect(JSON.parse(reveal.stdout).result.effectiveExecutor).toMatchObject({ executorId: 'codex', source: 'provider-default', command: 'codex' })
  const defaultOnly = await h.remove('codex', override.registrationRevision!)
  expect(defaultOnly.code).not.toBe(0); expect(JSON.parse(defaultOnly.stderr).error.code).toBe('HOST_EXECUTOR_NOT_REGISTERED')
  const wrongHost = await h.cli(['unregister', 'aba', '--host', 'different-host', '--registration-revision', second.registrationRevision!])
  expect(wrongHost.code).not.toBe(0)
  const lost = await h.register('lost-reply')
  await writeFile(join(h.f.env.AGENTMUX_STATE_DIRECTORY!, 'lose-remove-reply'), 'private transport fault')
  const unknown = await h.remove('lost-reply', lost.registrationRevision!)
  expect(unknown.code).not.toBe(0)
  const registry = join(h.f.env.AGENTMUX_STATE_DIRECTORY!, 'host-executors.json')
  const committed = await readFile(registry, 'utf8')
  expect(JSON.parse(committed).executors).not.toHaveProperty('lost-reply')
  await h.f.restart()
  for (let i = 0; i < 2; i++) {
    const current = await h.cli(['discover', '--host', 'local'])
    expect(current.code, current.stderr).toBe(0)
    expect(JSON.parse(current.stdout).result.executors.some((d: core.AgentMuxHostExecutorDescriptor) => d.executorId === 'lost-reply')).toBe(false)
  }
  expect(await readFile(registry, 'utf8')).toBe(committed)

})

it('retained original Session and retired history refuse removal while same-SID native recovery survives private Host restart', async () => {
  const h = await product()
  let client = await h.f.client()
  const executor = await h.register('retained', config(resolve('packages/core/test/fixtures/fake-codex-cli.mjs'), {
    CODEX_HOME: join(h.f.root, 'home'), AGENTMUX_FAKE_READY_MODE: 'before', AGENTMUX_FAKE_NATIVE_RECORD: '1',
    AGENTMUX_FAKE_NATIVE_PRESERVE: '1', AGENTMUX_FAKE_NATIVE_RECORD_DIRECTORY: join(h.f.root, 'native'), AGENTMUX_FAKE_NATIVE_CONTEXT: 'Original unregister recovery context'
  }))
  const created = await client.createHostAgentWithDelivery({ agentSessionId: 'original-retained', createOperationId: 'original-retained-create',
    executorId: 'retained', executorRevision: executor.configRevision, workspacePath: h.f.root })
  const sid = created.session.agentSessionId
  cleanup.push(async () => { const current = await h.f.client(); const session = await current.readAgentSession(sid); if (session) await current.stopAgent(sid, session.run) })
  const original = await until(() => client.statusAgent(sid), value => !!value.session.nativeHandle, 'original Provider native identity')
  const denied = await h.remove('retained', executor.registrationRevision!)
  expect(denied.code).not.toBe(0); expect(JSON.parse(denied.stderr).error.code).toBe('EXECUTOR_REFERENCED')
  await client.writeAgent({ agentSessionId: sid, expectedRun: original.session.run, data: 'still-usable\n', source: 'user' })
  const status = await client.statusAgent(sid)
  expect(status.session.creation?.executorRevision).toBe(executor.configRevision)
  const originalNative = original.session.nativeHandle
  expect(status.run.pid).toBeGreaterThan(1)
  process.kill(status.run.pid!, 'SIGTERM')
  await until(() => client.statusAgent(sid), value => value.run.state === 'exited', 'private original CLI exit')
  await h.rpc.call('agent.resume', { target: { kind: 'agent-session', agentSessionId: sid }, operationId: 'original-retained-resume', text: '' })
  const resumed = await until(() => client.statusAgent(sid), value => value.session.run.runId !== original.session.run.runId && value.run.state === 'running', 'same-SID resume')
  expect(resumed.session.nativeHandle).toEqual(originalNative)
  await h.rpc.dispose(); const oldPid = h.f.ownerProcess.pid; await h.f.restart(); expect(h.f.ownerProcess.pid).not.toBe(oldPid)
  client = await h.f.client()
  const reopened = await client.statusAgent(sid)
  expect(reopened.session.run).toEqual(resumed.session.run); expect(reopened.session.nativeHandle).toEqual(originalNative)
  const deniedAgain = await h.remove('retained', executor.registrationRevision!)
  expect(deniedAgain.code).not.toBe(0); expect(JSON.parse(deniedAgain.stderr).error.code).toBe('EXECUTOR_REFERENCED')
  await client.stopAgent(sid, reopened.session.run)
  const retired = await h.remove('retained', executor.registrationRevision!)
  expect(retired.code).not.toBe(0); expect(JSON.parse(retired.stderr).error.code).toBe('EXECUTOR_REFERENCED')
})

it('legacy data stays read-only and intact; original lease/metadata guard and concurrent publication serialize without a long lifecycle lock', async () => {
  const f = await rpcOwnerFixture(['caller'], core); cleanup.push(f.close)
  const registryPath = join(f.root, 'host-executors.json'), value = config(process.execPath, { RETAINED_SECRET: 'original' })
  const legacy = JSON.stringify({ schema: 'agentmux.host-executors.v1', runtimeId: 'private-runtime', executors: { legacy: value } })
  await writeFile(registryPath, legacy)
  const owner = new AgentMuxHostExecutorOwner({ path: registryPath, runtimeId: 'private-runtime', catalog: () => f.client.catalog() })
  const descriptor = (await owner.list()).executors.find(item => item.executorId === 'legacy')!
  expect(descriptor.registrationRevision).toMatch(/^legacy-observation:/u); expect(await readFile(registryPath, 'utf8')).toBe(legacy)
  expect((await owner.resolve('legacy')).config).toEqual(value); expect(await readFile(registryPath, 'utf8')).toBe(legacy)
  const release = await owner.retainLaunch('legacy')
  await expect(owner.remove({ executorId: 'legacy', expectedRegistrationRevision: descriptor.registrationRevision! }, async () => {})).rejects.toMatchObject({ code: 'EXECUTOR_REFERENCED' })
  // Another independent registry operation still completes while that launch is retained.
  await owner.configure({ executorId: 'unrelated', config: value })
  release()
  let allow!: () => void
  const held = new Promise<void>(done => { allow = done })
  const removal = owner.remove({ executorId: 'legacy', expectedRegistrationRevision: descriptor.registrationRevision! }, async () => { await held })
  const rebuilt = owner.configure({ executorId: 'legacy', config: value })
  allow(); await removal
  const next = await rebuilt
  expect(next.executor.configRevision).toBe(descriptor.configRevision)
  expect(next.executor.registrationRevision).not.toBe(descriptor.registrationRevision)
  await expect(owner.remove({ executorId: 'legacy', expectedRegistrationRevision: descriptor.registrationRevision! }, async () => {})).rejects.toMatchObject({ code: 'EXECUTOR_REGISTRATION_CONFLICT' })
  // Raw SDK callers can mutate their own input after enqueueing. Retain the exact
  // target used by both the registry CAS and original Session-reference query.
  const client = new core.AgentMuxClient({ store: f.store, hostExecutorOwner: owner }); cleanup.push(() => client.dispose())
  const references = vi.spyOn(f.store, 'hostExecutorReferenced').mockImplementation(async (_host, id) => id === 'legacy')
  const other = (await owner.list()).executors.find(item => item.executorId === 'unrelated')!
  let unblock!: () => void, checking = false
  const gate = new Promise<void>(done => { unblock = done })
  const preceding = owner.remove({ executorId: 'unrelated', expectedRegistrationRevision: other.registrationRevision! }, async () => { checking = true; await gate })
  await vi.waitFor(() => expect(checking).toBe(true))
  const request = { executorId: 'legacy', expectedRegistrationRevision: next.executor.registrationRevision! }
  const exact = client.removeHostExecutor(request); request.executorId = 'another-target'
  unblock(); await preceding
  await expect(exact).rejects.toMatchObject({ code: 'EXECUTOR_REFERENCED' })
  expect(references).toHaveBeenCalledWith('local', 'legacy')
  const bytes = JSON.parse(await readFile(registryPath, 'utf8')); bytes.registrationRevisions.legacy = 42
  await writeFile(registryPath, JSON.stringify(bytes))
  expect((await owner.resolve('legacy')).config).toEqual(value)
  await expect(owner.remove({ executorId: 'legacy', expectedRegistrationRevision: next.executor.registrationRevision! }, async () => {})).rejects.toMatchObject({ code: 'EXECUTOR_REGISTRATION_UNAVAILABLE' })
})

it('actual Core hosted-creation admission protects an in-flight launch without holding unrelated registry work', async () => {
  const h = await spawnOwnerFixture(cleanup, true)
  const executor = (await h.client.listHostExecutors()).executors.find(value => value.executorId === 'private-executor')!
  const probe = Reflect.get(h.client, 'probePreparedAgent') as ReturnType<typeof vi.fn>
  const originalProbe = probe.getMockImplementation()!
  let entered = false, release!: () => void
  const held = new Promise<void>(done => { release = done })
  probe.mockImplementationOnce(async (...args: unknown[]) => { entered = true; await held; return originalProbe(...args) })
  const pending = h.client.createHostAgentWithDelivery({ agentSessionId: 'in-flight-child', createOperationId: 'in-flight-create',
    executorId: executor.executorId, executorRevision: executor.configRevision, workspacePath: h.root })
  try {
    await vi.waitFor(() => expect(entered).toBe(true))
    await expect(h.rpc.call('settings.executors.unregister', { hostId: 'local', executorId: executor.executorId,
      expectedRegistrationRevision: executor.registrationRevision! })).rejects.toMatchObject({ code: 'EXECUTOR_REFERENCED' })
    await h.client.configureHostExecutor({ executorId: 'other-independent', config: config('/bin/sh') })
    expect((await h.client.listHostExecutors()).executors.some(value => value.executorId === 'other-independent')).toBe(true)
  } finally { release() }
  const created = await pending
  expect(created.session.agentSessionId).toBe('in-flight-child')
  expect(created.session.creation?.executorRevision).toBe(executor.configRevision)
  await expect(h.client.removeHostExecutor({ executorId: executor.executorId, expectedRegistrationRevision: executor.registrationRevision! })).rejects.toMatchObject({ code: 'EXECUTOR_REFERENCED' })
})

it('queued raw Host SDK creation freezes the whole original request before its registry admission await', async () => {
  const h = await spawnOwnerFixture(cleanup, true)
  const registry = Reflect.get(h.client, 'hostExecutorOwner') as AgentMuxHostExecutorOwner
  const registered = await h.client.configureHostExecutor({ executorId: 'original-b', config: {
    label: 'Original B', providerId: 'claude', command: '/bin/sh', args: ['--original-b'], env: { ORIGINAL_TARGET: 'B' }, injectAgentMuxGuide: false
  } })
  const blocker = await h.client.configureHostExecutor({ executorId: 'queue-blocker', config: config('/bin/sh') })
  let unblock!: () => void, queueEntered = false
  const queueGate = new Promise<void>(done => { unblock = done })
  const preceding = registry.remove({ executorId: 'queue-blocker', expectedRegistrationRevision: blocker.executor.registrationRevision! }, async () => { queueEntered = true; await queueGate })
  await vi.waitFor(() => expect(queueEntered).toBe(true))
  const probe = Reflect.get(h.client, 'probePreparedAgent') as ReturnType<typeof vi.fn>
  const originalProbe = probe.getMockImplementation()!
  let finishProbe!: () => void, probeEntered = false
  const probeGate = new Promise<void>(done => { finishProbe = done })
  probe.mockImplementationOnce(async (...args: unknown[]) => { probeEntered = true; await probeGate; return originalProbe(...args) })
  const request: Parameters<typeof h.client.createHostAgentWithDelivery>[0] = {
    agentSessionId: 'original-queued-child', createOperationId: 'original-queued-cid', executorId: 'original-b',
    executorRevision: registered.executor.configRevision, workspacePath: h.root
  }
  const pending = h.client.createHostAgentWithDelivery(request)
  void pending.catch(() => {})
  Object.assign(request, { agentSessionId: 'tampered-child', createOperationId: 'tampered-cid', executorId: 'private-executor',
    executorRevision: (await h.client.listHostExecutors()).executors.find(value => value.executorId === 'private-executor')!.configRevision,
    workspacePath: '/tampered-workspace', prompt: 'A later mutation must not replace the original request.' })
  try {
    unblock(); await preceding
    await vi.waitFor(() => expect(probeEntered).toBe(true))
    await expect(h.client.removeHostExecutor({ executorId: 'original-b', expectedRegistrationRevision: registered.executor.registrationRevision! })).rejects.toMatchObject({ code: 'EXECUTOR_REFERENCED' })
    const independent = (await h.client.listHostExecutors()).executors.find(value => value.executorId === 'private-executor')!
    await expect(h.client.removeHostExecutor({ executorId: independent.executorId, expectedRegistrationRevision: independent.registrationRevision! })).resolves.toMatchObject({ removedRegistration: true })
  } finally { unblock(); finishProbe() }
  await expect(pending).resolves.toMatchObject({ session: { agentSessionId: 'original-queued-child', executorId: 'original-b' } })
  const created = await pending
  expect(created.session).toMatchObject({ agentSessionId: 'original-queued-child', executorId: 'original-b', workspacePath: h.root,
    creation: { createOperationId: 'original-queued-cid', executorRevision: registered.executor.configRevision, initialPrompt: 'not-requested' } })
  expect(h.launches).toHaveLength(1)
  expect(h.launches[0]!.args).toContain('--original-b'); expect(h.launches[0]!.env.ORIGINAL_TARGET).toBe('B')
  expect(h.runs[0]!.workspacePath).toBe(h.root)
  expect(await h.client.readAgentSession('tampered-child')).toBeNull()
})
