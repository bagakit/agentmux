import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { creationInputOwner } from '../../../packages/core/test/helpers/creation-input-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { createWorkspaceLayout, createWorkbenchViewLayout } from '../../../packages/core/src/spatial-layout.js'
import { fixtureHostExecutorOptions } from './helpers/configured-executor-owner.js'

const native = vi.hoisted(() => ({ client: null as any }))
vi.mock('@agentmux/core', async original => {
  const actual = await original<typeof import('@agentmux/core')>()
  return { ...actual, startHeadlessAgentMux: async (options: Parameters<typeof actual.startHeadlessAgentMux>[0]) => {
    // Only the Native transport is controlled. The real Host composes its original
    // configuration, Files, spatial admission and public Unix RPC service below.
    const server = new actual.AgentMuxControlServer({ ...options.service, socketPath: options.socketPath,
      coreClients: () => [{ hostId: 'local', client: native.client }] })
    await server.start()
    return { client: native.client, server, hosted: {}, stop: () => server.stop() }
  } }
})
import * as core from '@agentmux/core'
import { moteMainBaseline } from '@agentmux/core/spatial-graph'
import { moteQuickBaseline } from '@agentmux/core/mote-preferences'
import { startAgentMuxHost } from '../src/host.js'
import { ScratchTopics } from '../src/mote-resources.js'
import { directoryIdentity, homeZoneId, parseMoteQuickMode } from '../src/mote-model.js'

const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllEnvs(); native.client = null
})
async function fixture() {
  let configurationPath = ''
  const h = await creationInputOwner(true, fixtureHostExecutorOptions(() => configurationPath)); cleanups.push(h.close); native.client = h.client
  const registry = vi.spyOn(h.client, 'listHostExecutors')
  const workspace = { id: '__scratch__', hostId: 'local', path: join(h.root, 'scratch'), name: 'Original Scratch' }
  await mkdir(workspace.path)
  const topic = await new ScratchTopics().ensureMote(workspace, 'launcher:custom-executor')
  const spaceId = directoryIdentity('local', topic.identityDirectoryPath!), zoneId = homeZoneId(spaceId)
  const path = join(topic.physicalDirectoryPath!, 'MOTE.md'), notes = '\n# Cooperation notes\nKeep my original agreements.\n'
  await writeFile(path, '---\nversion: 1\nprivate: original\ndefaults: {}\n---\n' + notes)
  const spatial = new core.AgentMuxSpatialStateStore()
  await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId, kind: 'mote', name: 'Original Mote', topicId: topic.id, hostId: 'local', directoryPath: topic.physicalDirectoryPath!, projectId: null }],
    zones: [{ zoneId, kind: 'home', workspaceId: workspace.id, hostId: 'local', directoryPath: topic.physicalDirectoryPath!, branch: null }],
    bindings: [{ spaceId, zoneId }], tabs: [{ tabId: 'original-tab', zoneId, workspaceId: workspace.id, name: null, regionIds: ['original-region'] }],
    regions: [{ tabId: 'original-tab', regionId: 'original-region', kind: 'launcher', agentSessionId: null, runId: null, execution: null }],
    layouts: { [workspace.id]: createWorkspaceLayout('original-group', ['original-tab']) },
    tabLayouts: { 'original-tab': createWorkbenchViewLayout('original-region') }, resources: { 'tab:original-tab': { draft: 'Original unsent draft' } }
  } })
  configurationPath = join(h.root, 'configuration.json')
  const configuration = { workspaces: [workspace], executors: { cck3: { label: 'My custom Executor', providerId: 'codex', command: 'original-wrapper', args: ['--original'], env: { ORIGINAL_LAUNCH: 'kept' }, injectAgentMuxGuide: false } } }
  await writeFile(configurationPath, JSON.stringify(configuration))
  const host = await startAgentMuxHost({ store: h.store, socketPath: join(h.root, 'host.sock'), configurationPath,
    mobilePort: 0, mobileBuildDirectory: join(h.root, 'absent-mobile') })
  cleanups.push(() => host.dispose())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: host.server.path } }); cleanups.push(() => rpc.dispose())
  const target = { spaceId, zoneId, expectedResource: { hostId: 'local', workspaceId: workspace.id, workspacePath: workspace.path } }
  const cli = async (action: 'read' | 'save', input: unknown) => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + host.server.path, 'space', 'mote', 'preferences', action, '--input', '-'], objectCliEnvironment(h.root), JSON.stringify(input), 30_000)
    expect(result.code, result.stderr || result.stdout).toBe(0)
    return JSON.parse(result.stdout).result
  }
  return { h, rpc, host, registry, target, spatial, configuration, configurationPath, path, notes, cli }
}

it('actual Host and compiled CLI save a configured custom Executor before any Main, then create with that original launch configuration', async () => {
  const f = await fixture(), before = (await f.spatial.read())!
  const reading = await f.cli('read', { kind: 'quick', target: f.target })
  expect(reading).toMatchObject({ status: 'ready', defaults: {}, choices: { executors: [{ id: 'cck3', name: 'My custom Executor', providerId: 'codex' }], conversations: [] } })
  expect((await f.rpc.call('space.mote.dialogue.read', { target: f.target, kind: 'main' })).main.current).toBeNull()
  const saved = await f.cli('save', { kind: 'quick', target: f.target, operationId: 'custom-executor-save', baseline: moteQuickBaseline(reading),
    values: { executorId: 'cck3' }, destination: reading.choices.destinations[0].reference })
  expect(saved).toMatchObject({ status: 'saved', source: { defaults: { executorId: 'cck3' } } })
  const content = await readFile(f.path, 'utf8')
  expect(content).toContain(f.notes); expect(content).toContain('private: original')
  expect(parseMoteQuickMode(content)).toEqual({ status: 'valid', defaults: saved.source.defaults })
  expect(saved.source.defaults.conversation).toBeUndefined()
  expect(f.h.started).toEqual([]); expect(f.h.inner.kernel.input).not.toHaveBeenCalled()
  const read = await f.rpc.call('space.mote.preferences.read', { kind: 'quick', target: f.target })
  const main = (await f.rpc.call('space.mote.dialogue.read', { target: f.target, kind: 'main' })).main
  const opened = await f.rpc.call('agent.open', { operationId: 'original-custom-main', content: { kind: 'new-agent', executorId: 'cck3' }, destination: { spaceId: f.target.spaceId, zoneId: f.target.zoneId, newTab: true }, focus: false,
    moteMain: { target: f.target, baseline: moteMainBaseline(moteQuickBaseline(read)!), expectedRoleRevision: main.roleRevision, sourceOperationId: 'custom-source', bindOperationId: 'custom-bind' } })
  expect(opened.outcome, JSON.stringify(opened.issues)).toBe('opened')
  const setup = await f.rpc.call('space.mote.dialogue.setup.inspect', { target: f.target, creation: { hostId: 'local', operationId: 'original-custom-main' } })
  expect(setup.record?.execution).toMatchObject({ runtimeId: 'fixture-original-execution-host', executorRevision: expect.any(String) })
  expect(setup.record?.execution.executorRevision).toBe((await f.h.client.readAgentSession(opened.agent!.agentSessionId))!.creation?.executorRevision)
  expect(f.h.started).toHaveLength(1)
  expect(f.h.started[0]).toMatchObject({ program: 'original-wrapper', args: expect.arrayContaining(['--original']), env: { ORIGINAL_LAUNCH: 'kept' } })
  expect(f.registry).toHaveBeenCalledWith({ refresh: false, executorId: 'cck3' }); expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
  expect((await f.spatial.read())!.graph.resources['tab:original-tab']).toEqual(before.graph.resources['tab:original-tab'])
})

it('a fresh Mote with no MOTE.md saves its original custom choice and rereads changed configuration without a registry or a Main', async () => {
  const f = await fixture(); await rm(f.path)
  const reading = await f.rpc.call('space.mote.preferences.read', { kind: 'quick', target: f.target })
  expect(reading).toMatchObject({ status: 'ready', source: { result: { status: 'deleted' } }, defaults: {}, choices: { conversations: [] } })
  const saved = await f.rpc.call('space.mote.preferences.save', { kind: 'quick', target: f.target, operationId: 'first-custom-choice', baseline: moteQuickBaseline(reading)!, values: { executorId: 'cck3' }, destination: reading.choices.destinations[0]!.reference })
  expect(saved.status, saved.message ?? '').toBe('saved')
  await writeFile(f.configurationPath, JSON.stringify({ ...f.configuration, executors: { another: { ...f.configuration.executors.cck3, label: 'Later original Executor' } } }))
  const later = await f.cli('read', { kind: 'quick', target: f.target })
  expect(later.defaults.executorId).toBe('cck3')
  expect(later.choices.executors).toEqual([{ id: 'another', name: 'Later original Executor', providerId: 'codex' }])
  expect(f.registry).not.toHaveBeenCalled(); expect(f.h.started).toEqual([]); expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('the original spatial creator retains its authenticated local caller and initial-message provenance through the Core Executor owner', async () => {
  const f = await fixture(), prompt = 'Original managed request with its exact author'
  const opened = await f.rpc.call('agent.open', { operationId: 'managed-original-spatial-create', content: { kind: 'new-agent', executorId: 'cck3', prompt },
    destination: { spaceId: f.target.spaceId, zoneId: f.target.zoneId, newTab: true }, focus: false }, { credentials: f.h.credentials })
  // This deterministic Native port does not acknowledge the managed Inbox's
  // consumption. Creation/provenance are confirmed independently of delivery.
  expect(opened.outcome, JSON.stringify(opened.issues)).toBe('partial')
  expect(opened.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'AGENT_CREATION_UNCONFIRMED' })]))
  const session = (await f.h.client.readAgentSession(opened.agent!.agentSessionId))!
  expect(session.creation?.initialMessageOrigin).toBeUndefined()
  expect(session.creation?.createdBy).toMatchObject({ agentSessionId: 'source', run: { runId: 'run-source' }, owner: { kind: 'local' } })
  expect(session.creation?.executorRevision).toEqual(expect.any(String))
  const messages = await f.h.client.listMessages({ participantSessionId: session.agentSessionId, direction: 'incoming', limit: 20 })
  expect(messages.messages).toEqual(expect.arrayContaining([expect.objectContaining({ bodyPreview: prompt,
    envelope: expect.objectContaining({ senderSessionId: 'source', senderRunId: 'run-source', recipientSessionId: session.agentSessionId }) })]))
  expect(f.h.started).toHaveLength(1); expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('local target-owned creation rejects invalid callers and changed original caller Runs while keeping the parent usable', async () => {
  const f = await fixture(), executor = (await f.h.client.listHostExecutors({ refresh: false, executorId: 'cck3' })).executors[0]!
  const input = { agentSessionId: 'local-auth-target', createOperationId: 'local-auth-create', executorId: 'cck3', executorRevision: executor.configRevision, workspacePath: f.h.root, prompt: 'Original local request' }
  await expect(f.h.client.createLocalHostAgentWithDelivery(input, { agentSessionId: 'source', capability: 'not-the-original-capability' })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  await expect(f.h.client.createHostAgentWithDelivery({ ...input, creationCaller: f.h.credentials } as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  f.h.probe.mockImplementationOnce(async () => {
    const before = (await f.h.store.readMetadata('source'))!
    await f.h.store.compareAndSwapMetadata(before, { ...before, run: { runId: 'original-parent-replacement-run' }, retiredRuns: [before.run], updatedAt: before.updatedAt + 1 })
    return { providerId: 'codex', executable: 'codex', installed: true, capabilities: f.h.provider.catalog.capabilities }
  })
  await expect(f.h.client.createLocalHostAgentWithDelivery({ ...input, agentSessionId: 'changed-local-source', createOperationId: 'changed-local-source-create' }, f.h.credentials)).rejects.toMatchObject({ code: 'AGENT_CREATION_SOURCE_CHANGED' })
  expect(f.h.started).toEqual([]); expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
  await f.h.inner.registry.refresh('source')
  await f.h.client.writeAgent({ agentSessionId: 'source', expectedRun: { runId: 'original-parent-replacement-run' }, data: 'Parent remains usable', source: 'user' })
  expect(f.h.rawInput).toHaveBeenCalledWith('original-parent-replacement-run', 'Parent remains usable')
})

it('unconfirmed original launch configuration stays explicit and does not disable healthy Agent input or write MOTE.md', async () => {
  const f = await fixture(), content = await readFile(f.path, 'utf8')
  // The Mote itself and its File are readable; only the launch configuration is invalid.
  await writeFile(f.configurationPath, JSON.stringify({ ...f.configuration, executors: [] }))
  const reading = await f.rpc.call('space.mote.preferences.read', { kind: 'quick', target: f.target })
  expect(reading.status).toBe('unconfirmed'); expect(reading.issue).toContain('Executor launch configuration')
  expect(reading.source).toMatchObject({ result: { status: 'read', document: { content } } })
  await f.h.client.writeAgent({ agentSessionId: 'source', expectedRun: { runId: 'run-source' }, data: 'Healthy original input', source: 'user' })
  expect(f.h.rawInput).toHaveBeenCalledWith('run-source', 'Healthy original input')
  expect(await readFile(f.path, 'utf8')).toBe(content)
  expect(f.h.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.h.started).toEqual([])
})

it('an unrelated invalid launch or unknown Provider metadata never blocks the healthy custom choice, while starting the exact invalid Executor is refused', async () => {
  const f = await fixture(), warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
  await writeFile(f.configurationPath, JSON.stringify({ ...f.configuration, executors: { ...f.configuration.executors,
    broken: { label: 'Needs original launch repair', providerId: 'codex', command: '', args: 'invalid', env: {} }, unknown: { label: 'Original Provider metadata unavailable' } } }))
  const read = await f.cli('read', { kind: 'quick', target: f.target })
  expect(read.status).toBe('ready')
  expect(read.choices.executors).toEqual([{ id: 'cck3', name: 'My custom Executor', providerId: 'codex' }, { id: 'broken', name: 'Needs original launch repair', providerId: 'codex' }])
  expect(warning).toHaveBeenCalledWith(expect.stringContaining('"unknown"'), { code: 'EXECUTOR_CONFIGURATION_UNAVAILABLE' })
  const saved = await f.cli('save', { kind: 'quick', target: f.target, operationId: 'healthy-choice-with-unrelated-invalid', baseline: moteQuickBaseline(read), values: { executorId: 'cck3' }, destination: read.choices.destinations[0].reference })
  expect(saved.status, saved.message ?? '').toBe('saved')
  await expect(f.rpc.call('agent.open', { operationId: 'exact-invalid-launch', content: { kind: 'new-agent', executorId: 'broken' }, destination: { spaceId: f.target.spaceId, zoneId: f.target.zoneId, newTab: true }, focus: false })).rejects.toMatchObject({ code: 'EXECUTOR_CONFIGURATION_UNAVAILABLE' })
  expect((await f.rpc.call('space.mote.preferences.read', { kind: 'quick', target: f.target })).defaults?.executorId).toBe('cck3')
  expect(f.h.started).toEqual([]); expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
})
