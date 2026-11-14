// @vitest-environment node
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { headlessFixture } from '../../../packages/core/test/helpers/headless-runtime-fixture.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { AgentMuxHostExecutorOwner } from '../../../packages/core/src/executor-owner.js'
import { AgentProviderRegistry } from '../../../packages/core/src/agent-provider.js'
import { readConfiguredExecutors } from '../src/mote-resources.js'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state.js'
import { createWorkspaceLayout, createWorkbenchViewLayout } from '../../../packages/core/src/spatial-layout.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
const configured = (label: string) => ({ label, providerId: 'codex', command: process.execPath, args: ['--original-private-argument'], env: { PRIVATE_SETTING: 'original-private-value' }, injectAgentMuxGuide: false })

async function product() {
  const loader = resolve(import.meta.dirname, 'configured-executor-node-loader.mjs'), previous = process.env.AGENTMUX_TEST_OWNER_ENTRY
  process.env.AGENTMUX_TEST_OWNER_ENTRY = resolve(import.meta.dirname, 'fixtures/mobile-web-host.mjs')
  let f: Awaited<ReturnType<typeof headlessFixture>>
  try { f = await headlessFixture({ ownerNodeArgs: ['--experimental-transform-types', '--import', loader] }) }
  finally { if (previous === undefined) delete process.env.AGENTMUX_TEST_OWNER_ENTRY; else process.env.AGENTMUX_TEST_OWNER_ENTRY = previous }
  closes.push(async () => {
    try { const client = await f.client(); for (const session of await client.readAgentSessions()) await client.stopAgent(session.agentSessionId, session.run) }
    finally { await f.cleanup() }
  })
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.socketPath } }); closes.push(() => rpc.dispose())
  const path = join(f.env.AGENTMUX_STATE_DIRECTORY!, 'original-configuration.json'), config = JSON.parse(await readFile(path, 'utf8'))
  const cli = async (args: string[]) => {
    const output = await promisify(execFile)(process.execPath, ['--experimental-transform-types', '--import', loader,
      resolve(import.meta.dirname, '../../../packages/core/src/agentmux.ts'), '--endpoint', 'unix:' + f.socketPath, 'settings', 'executors', ...args], { env: f.env, timeout: 20_000 })
    return JSON.parse(output.stdout).result
  }
  return { f, rpc, path, config, cli }
}

it('the original default Host publishes saved same-Provider Executors through RPC and CLI across process restart without registering or copying them', async () => {
  const loader = resolve(import.meta.dirname, 'configured-executor-node-loader.mjs')
  const previous = process.env.AGENTMUX_TEST_OWNER_ENTRY
  process.env.AGENTMUX_TEST_OWNER_ENTRY = resolve(import.meta.dirname, 'fixtures/mobile-web-host.mjs')
  let f: Awaited<ReturnType<typeof headlessFixture>>
  try { f = await headlessFixture({ ownerNodeArgs: ['--experimental-transform-types', '--import', loader] }) }
  finally { if (previous === undefined) delete process.env.AGENTMUX_TEST_OWNER_ENTRY; else process.env.AGENTMUX_TEST_OWNER_ENTRY = previous }
  closes.push(() => f.cleanup())
  const path = join(f.env.AGENTMUX_STATE_DIRECTORY!, 'original-configuration.json'), original = JSON.parse(await readFile(path, 'utf8'))
  original.executors = { codex: configured('Saved default'), cck3: configured('My cck3'), second: configured('Other same Provider') }
  await writeFile(path, JSON.stringify(original))
  const bytes = await readFile(path, 'utf8')
  async function check() {
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.socketPath } })
    try {
      const reading = await rpc.call('settings.executors.discover', { hostId: 'local', refresh: false })
      expect(reading.executors.filter(value => value.source === 'configured').map(value => [value.executorId, value.label, value.providerId]))
        .toEqual([['codex', 'Saved default', 'codex'], ['cck3', 'My cck3', 'codex'], ['second', 'Other same Provider', 'codex']])
      expect(reading.executors.filter(value => value.source === 'configured').every(value => value.registrationRevision === undefined)).toBe(true)
      expect(JSON.stringify(reading)).not.toMatch(/original-private-argument|original-private-value|PRIVATE_SETTING/)
      const cli = await promisify(execFile)(process.execPath, ['--experimental-transform-types', '--import', loader,
        resolve(import.meta.dirname, '../../../packages/core/src/agentmux.ts'), '--endpoint', 'unix:' + f.socketPath,
        'settings', 'executors', 'discover', '--host', 'local', '--refresh', 'false'], { env: f.env, timeout: 20_000 })
      expect(JSON.parse(cli.stdout).result.executors).toEqual(reading.executors)
      const selected = await rpc.call('settings.executors.discover', { hostId: 'local', executorId: 'cck3', refresh: false })
      expect(selected.executors).toHaveLength(1); expect(selected.executors[0]).toMatchObject({ executorId: 'cck3', source: 'configured', launchOptions: expect.any(Array) })
      expect((await (await f.client()).readAgentSessions())).toEqual([])
    } finally { await rpc.dispose() }
  }
  await check()
  const restarted = await f.restart(); expect(restarted.owner.runtimeId).toBe(f.owner.runtimeId)
  await check()
  expect(await readFile(path, 'utf8')).toBe(bytes)
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.socketPath } })
  try {
    await writeFile(path, 'private-json-error-marker original-private-value')
    const failure = await rpc.call('settings.executors.discover', { hostId: 'local', refresh: false }).then(() => null, error => error)
    expect(failure).toMatchObject({ code: 'EXECUTOR_CONFIGURATION_UNAVAILABLE' })
    expect(JSON.stringify(failure)).not.toMatch(/private-json-error-marker|original-private-value/)
  } finally { await writeFile(path, bytes); await rpc.dispose() }
  await expect(readFile(join(f.env.AGENTMUX_STATE_DIRECTORY!, 'host-executors.json'))).rejects.toMatchObject({ code: 'ENOENT' })
}, 60_000)

it('exact configured and registered choices retain original launch authority when unrelated configuration is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amux-configured-owner-')); closes.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'original-config.json'), registry = join(root, 'registered-executors.json')
  await writeFile(path, JSON.stringify({ executors: { cck3: configured('Saved cck3'), unrelated: { providerId: 'codex', command: '' } } }))
  const owner = new AgentMuxHostExecutorOwner({ path: registry, runtimeId: 'exact-host', catalog: () => new AgentProviderRegistry().catalog(),
    configurations: id => readConfiguredExecutors(path, id) })
  const resolved = await owner.resolve('cck3')
  expect(resolved.config).toEqual(configured('Saved cck3'))
  expect(resolved.descriptor).toMatchObject({ source: 'configured', availability: 'available', executorId: 'cck3' })
  expect((await owner.list({ executorId: 'cck3' })).executors).toHaveLength(1)
  await expect(owner.list()).rejects.toMatchObject({ code: 'EXECUTOR_CONFIGURATION_UNAVAILABLE' })
  const registered = await owner.configure({ executorId: 'cck3', config: configured('Explicit override') })
  expect(registered.executor.source).toBe('registered')
  const registeredBytes = await readFile(registry, 'utf8')
  await writeFile(path, 'unreadable original JSON')
  expect((await owner.resolve('cck3')).config.label).toBe('Explicit override')
  expect((await owner.list({ executorId: 'cck3' })).executors[0]?.source).toBe('registered')
  await expect(owner.remove({ executorId: 'cck3', expectedRegistrationRevision: registered.executor.registrationRevision! }, async () => {})).rejects.toThrow()
  expect(await readFile(registry, 'utf8')).toBe(registeredBytes)
  await writeFile(path, JSON.stringify({ executors: { cck3: configured('Saved cck3') } }))
  const removal = await owner.remove({ executorId: 'cck3', expectedRegistrationRevision: registered.executor.registrationRevision! }, async () => {})
  expect(removal.effectiveExecutor).toMatchObject({ executorId: 'cck3', source: 'configured', label: 'Saved cck3' })
  expect(removal.effectiveExecutor?.registrationRevision).toBeUndefined()
  expect((await owner.resolve('cck3')).config.label).toBe('Saved cck3')
}, 30_000)

it('public RPC and CLI removal acknowledge the exact configured fallback without a forged registration witness', async () => {
  const h = await product(), saved = configured('Original saved choice')
  await expect(h.rpc.call('runtime.invoke', { consumerId: 'private-executor-owner-test', fence: { runtimeId: h.f.owner.runtimeId, ownerInstanceId: h.f.owner.ownerInstanceId },
    invocation: { method: 'createLocalHostAgentWithDelivery', args: [{}, {}] } } as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST', message: 'The method is outside the finite SDK surface.' })
  h.config.executors = { same: saved }; await writeFile(h.path, JSON.stringify(h.config))
  const original = await readFile(h.path, 'utf8')
  const first = await h.rpc.call('settings.executors.register', { hostId: 'local', executorId: 'same', input: { config: configured('Registered override') } })
  const rpcReceipt = await h.rpc.call('settings.executors.unregister', { hostId: 'local', executorId: 'same', expectedRegistrationRevision: first.executor.registrationRevision! })
  expect(rpcReceipt).toMatchObject({ removedRegistration: true, registrationRevision: first.executor.registrationRevision,
    effectiveExecutor: { executorId: 'same', source: 'configured', label: saved.label } })
  expect(rpcReceipt.effectiveExecutor?.registrationRevision).toBeUndefined()
  const second = await h.rpc.call('settings.executors.register', { hostId: 'local', executorId: 'same', input: { config: configured('Registered override') } })
  const cliReceipt = await h.cli(['unregister', 'same', '--host', 'local', '--registration-revision', second.executor.registrationRevision!])
  expect(cliReceipt).toMatchObject({ removedRegistration: true, registrationRevision: second.executor.registrationRevision,
    effectiveExecutor: { executorId: 'same', source: 'configured', label: saved.label } })
  expect(cliReceipt.effectiveExecutor.registrationRevision).toBeUndefined()
  const current = await h.cli(['discover', '--host', 'local', '--executor', 'same', '--refresh', 'false'])
  expect(current.executors).toHaveLength(1); expect(current.executors[0]).toEqual(cliReceipt.effectiveExecutor ? { ...cliReceipt.effectiveExecutor, launchOptions: current.executors[0].launchOptions, creationContract: { ordinaryLaunch: 1 } } : null)
  expect(await readFile(h.path, 'utf8')).toBe(original)
}, 60_000)

it('actual spatial agent.open launches the effective registered-only and same-ID registered command and environment', async () => {
  const h = await product(), client = await h.f.client(), command = resolve('packages/core/test/fixtures/fake-codex-cli.mjs')
  const wrapper = join(h.f.root, 'registered-wrapper.mjs')
  await writeFile(wrapper, '#!/usr/bin/env node\nimport ' + JSON.stringify(pathToFileURL(command).href) + '\n'); await chmod(wrapper, 0o755)
  const saved = { ...configured('Saved same ID'), command, args: ['--saved-only'], env: { PRIVATE_SETTING: 'saved-only', CODEX_HOME: join(h.f.root, 'home') } }
  h.config.executors = { same: saved }; await writeFile(h.path, JSON.stringify(h.config))
  const source = new AgentMuxSpatialStateStore(join(h.f.env.AGENTMUX_STATE_DIRECTORY!, 'spatial-state.json'))
  await source.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId: 'original-space', kind: 'folder', name: 'Original', hostId: 'local', directoryPath: h.f.root, projectId: null }],
    zones: [{ zoneId: 'original-zone', kind: 'directory', workspaceId: 'original-workspace', hostId: 'local', directoryPath: h.f.root, branch: null }],
    bindings: [{ spaceId: 'original-space', zoneId: 'original-zone' }],
    tabs: [{ tabId: 'original-tab', zoneId: 'original-zone', workspaceId: 'original-workspace', name: null, regionIds: ['original-region'] }],
    regions: [{ tabId: 'original-tab', regionId: 'original-region', kind: 'launcher', agentSessionId: null, runId: null, execution: null }],
    layouts: { 'original-workspace': createWorkspaceLayout('original-group', ['original-tab']) },
    tabLayouts: { 'original-tab': createWorkbenchViewLayout('original-region') }, resources: { 'tab:original-tab': { draft: 'Original unsent draft' } }
  } })
  const { CtxmuxClient } = await import(/* @vite-ignore */ pathToFileURL(resolve('packages/core/node_modules/@ctxmux/sdk/dist/index.js')).href)
  const native = new CtxmuxClient({ socketPath: join(h.f.env.AGENTMUX_RUNTIME_DIRECTORY!, 'ctxmux.sock') })
  for (const executorId of ['same', 'registered-only']) {
    const config = { ...saved, label: 'Exact registered ' + executorId, command: wrapper, args: ['--registered-only'], env: { ...saved.env, PRIVATE_SETTING: 'registered-only' } }
    const registered = await h.rpc.call('settings.executors.register', { hostId: 'local', executorId, input: { config } })
    const opened = await h.rpc.call('agent.open', { operationId: 'original-registered-' + executorId, content: { kind: 'new-agent', executorId }, destination: { spaceId: 'original-space', zoneId: 'original-zone', newTab: true }, focus: false })
    expect(opened.outcome, JSON.stringify(opened.issues)).toBe('opened')
    const session = (await client.readAgentSession(opened.agent!.agentSessionId))!
    expect(session.executorId).toBe(executorId); expect(session.creation?.executorRevision).toBe(registered.executor.configRevision)
    const actual = await native.status(session.run.runId)
    expect(actual.spec.cwd).toBe(h.f.root); expect(actual.spec.args).toContain(wrapper); expect(actual.spec.args).toContain('--registered-only')
    expect(actual.spec.args).not.toContain('--saved-only'); expect(actual.spec.env.PRIVATE_SETTING).toBe('registered-only')
    const admitted = (await source.read())!.graph.resources['core:agent-open'] as { requests: Record<string, {execution: unknown}> }
    expect(admitted.requests['original-registered-' + executorId]!.execution).toMatchObject({ runtimeId: h.f.owner.runtimeId, executorRevision: registered.executor.configRevision })
    const before = actual.id
    const repeated = await h.rpc.call('agent.open', { operationId: 'original-registered-' + executorId, content: { kind: 'new-agent', executorId }, destination: { spaceId: 'original-space', zoneId: 'original-zone', newTab: true }, focus: false })
    expect(repeated.agent?.runId).toBe(before)
  }
  const other = join(h.f.root, 'other-path'); await mkdir(other)
  const differentWrapper = join(other, 'registered-wrapper.mjs')
  await writeFile(differentWrapper, '#!/usr/bin/env node\nthrow Error("A PATH program must not replace the workspace command")\n'); await chmod(differentWrapper, 0o755)
  h.config.executors.relative = { ...saved, command: './registered-wrapper.mjs', args: ['--relative-workspace'], env: { ...saved.env, PATH: other + ':' + process.env.PATH } }
  await writeFile(h.path, JSON.stringify(h.config))
  const relative = await h.rpc.call('agent.open', { operationId: 'original-relative-command', content: { kind: 'new-agent', executorId: 'relative' },
    destination: { spaceId: 'original-space', zoneId: 'original-zone', newTab: true }, focus: false })
  expect(relative.outcome, JSON.stringify(relative.issues)).toBe('opened')
  const relativeSession = (await client.readAgentSession(relative.agent!.agentSessionId))!, relativeRun = await native.status(relativeSession.run.runId)
  expect(relativeRun.spec.args).toContain('./registered-wrapper.mjs'); expect(relativeRun.spec.args).not.toContain(differentWrapper)
  expect(relativeRun.spec.args).toContain('--relative-workspace')
  expect((await source.read())!.graph.resources['tab:original-tab']).toEqual({ draft: 'Original unsent draft' })
}, 60_000)

it('configured relative paths preserve the launch workspace command instead of selecting a different PATH executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amux-relative-executor-')); closes.push(() => rm(root, { recursive: true, force: true }))
  const bin = join(root, 'path'), cwd = join(root, 'workspace'); await mkdir(bin); await mkdir(cwd)
  for (const directory of [bin, cwd]) { await writeFile(join(directory, 'wrapper'), '#!/bin/sh\nexit 0\n'); await chmod(join(directory, 'wrapper'), 0o755) }
  const original = { ...configured('Original relative wrapper'), command: './wrapper', env: { PATH: bin } }
  const owner = new AgentMuxHostExecutorOwner({ path: join(root, 'registered.json'), runtimeId: 'relative-host', catalog: () => new AgentProviderRegistry().catalog(), configurations: async () => ({ saved: original }) })
  const inventory = await owner.list({ executorId: 'saved', refresh: true })
  expect(inventory.executors[0]).toMatchObject({ source: 'configured', command: './wrapper', availability: 'check-failed', cause: { code: 'EXECUTABLE_WORKSPACE_REQUIRED' } })
  expect(inventory.executors[0]?.executable).toBeUndefined()
  const selected = await owner.resolve('saved')
  expect(selected.config.command).toBe('./wrapper'); expect(selected.descriptor.executable).toBeUndefined()
})
