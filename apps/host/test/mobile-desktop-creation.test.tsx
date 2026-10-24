// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { AgentMuxSpatialStateStore, spatialAgentOpenRecord } from '../../../packages/core/src/spatial-state.js'
import { createWorkspaceLayout, createWorkbenchViewLayout } from '../../../packages/core/src/spatial-layout.js'
import { connectRelayHostedClient } from '../../../packages/core/src/relay-hosted.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { until } from '../../../packages/core/test/helpers/headless-runtime-fixture.js'
import { runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { desktopWorkbenchFromSpatial, reconcileSpatialGraphs } from '../../desktop/src/renderer/src/lib/desktop-spatial-state.js'
import { MobileAgentCreate } from '../../mobile/src/navigation/MobileAgentCreate.js'
import { createBrowserPlatform } from '../../mobile/src/platform/browser.js'
import { getDeviceWorkface, emptyDeviceWorkface } from '../../mobile/src/recovery/device-workface.js'
import { AgentMuxError } from '../../../packages/core/src/errors.js'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service.js'
import { createHostSpatialAgentControl } from '../src/spatial-agent-control.js'
import { mobileWebFixture } from './helpers/mobile-web-fixture.js'
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const WebSocket = createRequire(join(process.cwd(), 'packages/relay/package.json'))('ws')
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs() })

it('the actual Mobile creator admits one original Session and durable workface without Desktop and inspects it after a real Host restart', async () => {
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', join(process.cwd(), 'packages/core/bin/amux'))
  vi.stubEnv('HEADLESS_MOBILE_CREATION_CRASH_PROOF', '1')
  const f = await mobileWebFixture({ nativeRecord: true }); cleanup.push(f.close)
  const created: Array<{ agentSessionId: string; run: { runId: string } }> = []
  cleanup.push(async () => { const client = await f.native.client(); for (const session of created) await client.stopAgent(session.agentSessionId, session.run) })
  const stateDirectory = f.native.env.AGENTMUX_STATE_DIRECTORY!, configurationPath = join(stateDirectory, 'original-configuration.json')
  const config = JSON.parse(await readFile(configurationPath, 'utf8'))
  config.executors.codex = { ...config.executors.codex, command: join(f.native.root, 'managed.mjs'), args: [], env: { AGENTMUX_FAKE_READY_MODE: 'before', AGENTMUX_FAKE_NATIVE_RECORD: '1' }, injectAgentMuxGuide: false,
    avatar: { badge: 'unconfirmed-decoration' } }
  await writeFile(configurationPath, JSON.stringify(config)); const configurationBytes = await readFile(configurationPath, 'utf8')
  const spatial = new AgentMuxSpatialStateStore(join(stateDirectory, 'spatial-state.json'))
  const spaceId = JSON.stringify(['local', f.native.root]), zoneId = 'original-zone'
  const graph = { spaces: [{ spaceId, kind: 'folder' as const, name: 'Original Workspace', hostId: 'local', directoryPath: f.native.root, projectId: spaceId }],
    zones: [{ zoneId, workspaceId: 'original-workspace', kind: 'directory' as const, hostId: 'local', directoryPath: f.native.root, branch: null }],
    tabs: [{ tabId: 'original-tab', zoneId, workspaceId: 'original-workspace', name: 'Original empty Tab', regionIds: ['original-launcher'] }],
    regions: [{ tabId: 'original-tab', regionId: 'original-launcher', kind: 'launcher' as const, agentSessionId: null, runId: null, execution: null }],
    bindings: [{ spaceId, zoneId }], layouts: { 'original-workspace': createWorkspaceLayout('original-group', ['original-tab']) },
    tabLayouts: { 'original-tab': createWorkbenchViewLayout('original-launcher') },
    resources: { 'tab:original-tab': { titleRegionId: 'original-launcher' }, 'region:original-launcher': { workspaceId: 'original-workspace' } } }
  await spatial.commit({ expectedRevision: 0, graph }); const before = (await spatial.read())!
  await f.startMain(); await f.stopMain()
  const controller = new AbortController()
  const phone = await connectRelayHostedClient({ offer: f.info.offer, name: 'Private Mobile creator', signal: controller.signal, createWebSocket: url => new WebSocket(url) })
  cleanup.push(async () => { controller.abort(); await phone.dispose() })
  localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element); cleanup.push(async () => { await act(async () => root.unmount()); element.remove() })
  await act(async () => { root.render(<MobileAgentCreate client={phone} connected visible target={{ spaceId, zoneId }} platform={createBrowserPlatform()} onClose={() => {}} openSession={() => {}} />) })
  const select = await until(async () => { await act(async () => {}); return document.querySelector<HTMLSelectElement>('[aria-label="新 Agent 执行器"]') }, value => Boolean(value?.querySelector('option[value="codex"]')), 'the actual Mobile creation form discovers its original Executor')
  await act(async () => { select!.value = 'codex'; select!.dispatchEvent(new Event('change', { bubbles: true })) })
  const create = [...document.querySelectorAll('button')].find(button => button.textContent === '创建 Agent')!
  expect(create).toBeDefined(); await act(async () => { create.click() })
  const retained = await until(async () => { await act(async () => {}); return getDeviceWorkface().snapshot().record.agentCreates?.[0] }, value => value?.phase === 'confirmed' || value?.phase === 'unknown', 'the real Mobile form retains its original creation receipt')
  expect(retained, document.body.textContent ?? '').toMatchObject({ phase: 'confirmed', agentSessionId: expect.any(String) })
  const first = await phone.forwardRpc('space.inspect', { target: { operationId: retained!.input.operationId } })
  expect(first.request).toMatchObject({ known: true, report: { operationId: retained!.input.operationId, outcome: 'opened', agent: { agentSessionId: retained!.agentSessionId, createOperationId: retained!.input.operationId }, save: { diskDurability: 'confirmed' } } })
  const session = await phone.readAgentSession(retained!.agentSessionId!); expect(session).toBeTruthy(); created.push(session!)
  expect(session!.creation?.createOperationId).toBe(retained!.input.operationId)
  const after = (await spatial.read())!, originalLayout = after.graph.layouts['original-workspace']!
  expect(originalLayout.activeGroupId).toBe('original-group'); expect(originalLayout.groups[0]!.activeTabId).toBe('original-tab')
  expect(after.graph.regions.find(region => region.regionId === 'original-launcher')).toEqual(graph.regions[0])
  const decoded = desktopWorkbenchFromSpatial(after.graph)
  expect(Object.values(decoded.tabs).flatMap(tab => Object.values(tab.regions))).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'agent', sessionId: session!.agentSessionId })]))
  const repeated = await phone.forwardRpc('agent.open', retained!.input)
  expect(repeated.agent?.agentSessionId).toBe(session!.agentSessionId); expect((await phone.readAgentSessions()).filter(value => value.creation?.createOperationId === retained!.input.operationId)).toHaveLength(1)
  const oldCreation = await phone.forwardRpc('agent.open', { ...retained!.input, operationId: 'mobile-web-private-author' })
  expect(oldCreation).toMatchObject({ outcome: 'unknown', to: null, agent: { agentSessionId: f.session.agentSessionId }, save: { layoutApplied: false } })
  expect((await spatial.read())!.graph.tabs).toEqual(after.graph.tabs)
  await expect(phone.forwardRpc('agent.open', { ...retained!.input, content: { ...retained!.input.content, prompt: 'another original intent' } })).rejects.toMatchObject({ code: 'SPACE_REQUEST_CONFLICT' })
  await expect(spatial.commit({ expectedRevision: before.revision, graph: before.graph })).rejects.toMatchObject({ code: 'SPATIAL_STATE_CONFLICT' })
  const merged = reconcileSpatialGraphs(before.graph, before.graph, after.graph)
  expect(merged.regions).toEqual(after.graph.regions); expect(merged.layouts).toEqual(after.graph.layouts)
  const missingAssociation = structuredClone(after.graph); delete missingAssociation.resources['core:agent-open']
  await spatial.commit({ expectedRevision: after.revision, graph: missingAssociation })
  expect((await spatial.read())!.graph.resources['core:agent-open']).toEqual(after.graph.resources['core:agent-open'])
  const launcherInput = { operationId: 'original-launcher-creation', content: { kind: 'new-agent' as const, executorId: 'codex', prompt: 'Original headless first instruction' }, destination: { spaceId, zoneId, tabId: 'original-tab', regionId: 'original-launcher' }, focus: false }
  const launcher = await phone.forwardRpc('agent.open', launcherInput)
  expect(launcher).toMatchObject({ outcome: 'opened', to: { tabId: 'original-tab', regionId: 'original-launcher' }, agent: { createOperationId: launcherInput.operationId, initialPrompt: 'confirmed' }, save: { diskDurability: 'confirmed' } })
  created.push((await phone.readAgentSession(launcher.agent!.agentSessionId))!)
  expect((await spatial.read())!.graph.tabs.find(tab => tab.tabId === 'original-tab')!.regionIds).toEqual(['original-launcher'])
  const firstRun = session!.run.runId, runtimeId = f.native.owner.runtimeId
  await writeFile(join(stateDirectory, 'mobile-test-creation-pause'), '*')
  await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === '创建 Agent')!.click() })
  const interruptedOperation = await until(async () => readFile(join(stateDirectory, 'mobile-test-creation-paused'), 'utf8').catch(() => ''), value => Boolean(value), 'the actual Host durably admits the original form intent before Core preparation')
  const interrupted = getDeviceWorkface().snapshot().record.agentCreates!.find(intent => intent.input.operationId === interruptedOperation)!
  expect(interrupted.phase).toBe('sending')
  const admitted = (await spatial.read())!.graph.resources['core:agent-open'] as any
  const reservedSessionId = admitted.requests[interruptedOperation].agentSessionId
  expect(await phone.readAgentSession(reservedSessionId)).toBeNull()
  const exited = once(f.native.ownerProcess, 'exit'); f.native.ownerProcess.kill('SIGKILL'); await exited
  await until(async () => { await act(async () => {}); return getDeviceWorkface().snapshot().record.agentCreates!.find(intent => intent.input.operationId === interruptedOperation)?.phase }, value => value === 'unknown', 'the real interrupted Mobile form preserves its original unknown intent')
  await rm(join(stateDirectory, 'mobile-test-creation-pause'))
  controller.abort(); await phone.dispose(); await f.native.restart()
  const rpc = await f.relay(), restored = await f.native.client(rpc)
  expect(restored.runtimeOwnerIdentity()?.runtimeId).toBe(runtimeId)
  expect((await restored.statusAgent(session!.agentSessionId)).run).toMatchObject({ runId: firstRun, state: 'running' })
  expect((await restored.forwardRpc('space.inspect', { target: { operationId: retained!.input.operationId } })).request).toMatchObject({ known: true, report: { outcome: 'opened', agent: { agentSessionId: session!.agentSessionId, runId: firstRun } } })
  expect((await restored.forwardRpc('space.inspect', { target: { operationId: 'old-unobserved-local-storage-request' } })).request).toMatchObject({ known: false, report: null })
  expect((await restored.forwardRpc('space.inspect', { target: { operationId: interruptedOperation } })).request).toMatchObject({ known: true, report: { outcome: 'unknown', agent: null } })
  expect(await restored.readAgentSession(reservedSessionId)).toBeNull()
  const latest = JSON.parse(await readFile(join(stateDirectory, 'mobile-test-owner.json'), 'utf8'))
  const resumedController = new AbortController()
  const resumedPhone = await connectRelayHostedClient({ offer: latest.offer, name: 'Private Mobile original creator continuation', signal: resumedController.signal, createWebSocket: url => new WebSocket(url) })
  cleanup.push(async () => { resumedController.abort(); await resumedPhone.dispose() })
  await act(async () => { root.render(<MobileAgentCreate client={resumedPhone} connected visible target={{ spaceId, zoneId }} platform={createBrowserPlatform()} onClose={() => {}} openSession={() => {}} />) })
  const continueButton = [...document.querySelectorAll('button')].find(button => button.textContent === '继续原创建')!
  expect(continueButton).toBeDefined(); await act(async () => { continueButton.click() })
  const continued = await until(async () => { await act(async () => {}); return {
    record: getDeviceWorkface().snapshot().record.agentCreates!.find(intent => intent.input.operationId === interruptedOperation),
    waiting: document.querySelector('.mobile-primary')?.textContent === '正在核对…' }
  }, value => !value.waiting && Boolean(value.record), 'the actual Mobile continuation finishes its original observation')
  expect(continued.record).toMatchObject({ phase: 'confirmed', agentSessionId: reservedSessionId })
  created.push((await resumedPhone.readAgentSession(reservedSessionId))!)
  expect((await resumedPhone.readAgentSessions()).filter(session => session.creation?.createOperationId === interruptedOperation)).toHaveLength(1)
  const output = await until(async () => (await restored.readRunReplay(created[1]!.run, 0, 'raw')).replay.map(event => event.data).join(''), value => value.includes('codex-ready:' + launcherInput.content.prompt), 'the actual original CLI consumed the exact first prompt')
  expect(output.split('codex-ready:' + launcherInput.content.prompt)).toHaveLength(2)
  await f.startMain()
  const desktop = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.native.socketPath + '.desktop' } }); cleanup.push(() => desktop.dispose())
  expect((await desktop.call('space.inspect', { target: { operationId: retained!.input.operationId } })).request?.report?.agent?.agentSessionId).toBe(session!.agentSessionId)
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + f.native.socketPath, 'space', 'inspect', '--operation-id', retained!.input.operationId], f.native.env)
  expect(cli.code, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result.request.report.agent.runId).toBe(firstRun)
  expect(await readFile(configurationPath, 'utf8')).toBe(configurationBytes)
}, 120_000)

it('a revoked original device fence after preparation retains the exact admission without dispatching creation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amx-spatial-creation-')); cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const spatial = new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: { spaces: [{ spaceId: 'space', kind: 'folder', name: 'Original', hostId: 'local', directoryPath: directory, projectId: null },
      { spaceId: 'unrelated-space', kind: 'folder', name: 'Unrelated', hostId: 'local', directoryPath: join(directory, 'unrelated'), projectId: null }],
    zones: [{ zoneId: 'zone', workspaceId: 'workspace', kind: 'directory', hostId: 'local', directoryPath: directory, branch: null }], tabs: [], regions: [],
    bindings: [{ spaceId: 'space', zoneId: 'zone' }], layouts: {}, tabLayouts: {}, resources: {} } })
  const configurationPath = join(directory, 'configuration.json')
  await writeFile(configurationPath, JSON.stringify({ executors: { original: { label: 'Original', providerId: 'codex', command: 'original-command', args: [], env: {}, injectAgentMuxGuide: false } } }))
  const create = vi.fn(async () => { throw new Error('This controlled test must not dispatch creation') })
  const owner = createHostSpatialAgentControl({ configurationPath, spatial, runtime: () => ({ client: {
    resolveAgentCreationSessionId: async () => 'original-session', createAgentWithDelivery: create,
    inspectAgentCreation: async () => { throw new AgentMuxError('Original creation has not started.', 'AGENT_CREATION_UNKNOWN') }
  } }) as any })
  let checks = 0
  const request = { schemaVersion: 5 as const, requestId: 'original-fenced-creation', operation: 'agent.open' as const, content: { kind: 'new-agent' as const, executorId: 'original' }, destination: { spaceId: 'space', zoneId: 'zone', newTab: true }, focus: false }
  const beforeInvalidTarget = await spatial.read()
  await expect(owner({ ...request, destination: { ...request.destination, spaceId: 'unrelated-space' } },
    { transport: 'relay', principal: { kind: 'device', id: 'original-device' } })).rejects.toMatchObject({ code: 'SPACE_PARENT_MISMATCH' })
  expect(await spatial.read()).toEqual(beforeInvalidTarget)
  expect(create).not.toHaveBeenCalled()
  let revoked = false
  const source = createHostSpatialAgentControl({ configurationPath, spatial, runtime: () => ({ client: {
    resolveAgentCreationSessionId: async () => 'original-session', createAgentWithDelivery: create,
    inspectAgentCreation: async () => { throw new AgentMuxError('Original creation has not started.', 'AGENT_CREATION_UNKNOWN') }
  } }) as any, agentMuxContext: async () => { await Promise.resolve(); revoked = true; return undefined } })
  await expect(source(request, { transport: 'relay', principal: { kind: 'device', id: 'original-device' }, assertCurrent: async () => {
    if (revoked) throw new AgentMuxError('The original device authorization changed during source preparation.', 'CONTROL_PERMISSION_DENIED')
  } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(await spatial.read()).toEqual(beforeInvalidTarget)
  expect(create).not.toHaveBeenCalled()
  const result = await owner(request, { transport: 'relay', principal: { kind: 'device', id: 'original-device' }, assertCurrent: async () => {
    if (++checks >= 4) throw new AgentMuxError('The original device authorization changed.', 'CONTROL_PERMISSION_DENIED')
  } })
  expect(result).toMatchObject({ operation: 'agent.open', outcome: 'unknown', agent: null, save: { diskDurability: 'confirmed' } })
  expect(create).not.toHaveBeenCalled()
  expect((await spatial.read())!.graph.regions).toMatchObject([{ agentSessionId: 'original-session', runId: null }])
  for (const requestId of ['constructor', 'toString', '__proto__']) {
    const admission = await spatial.admitAgentOpen({ request: { ...request, requestId }, agentSessionId: 'reserved-' + requestId,
      execution: { hostId: 'local', workspacePath: directory, workspaceId: 'workspace' }, regionResource: {} })
    expect(admission.admitted).toBe(true)
    expect(spatialAgentOpenRecord((await spatial.read())!.graph, requestId)).toMatchObject({ requestId, agentSessionId: 'reserved-' + requestId })
    const originalAdmission = await spatial.read()
    await expect(spatial.admitAgentOpen({ request: { ...request, requestId }, agentSessionId: 'another-session',
      execution: { hostId: 'local', workspacePath: directory, workspaceId: 'workspace' }, regionResource: {} })).rejects.toMatchObject({ code: 'SPACE_TARGET_CHANGED' })
    expect(await spatial.read()).toEqual(originalAdmission)
  }
})

it('the public owners retain confirmed foreign creation and route an unknown target to the original Host', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amx-spatial-foreign-')); cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const spatial = new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId: 'foreign-space', kind: 'folder', name: 'Original foreign Space', hostId: 'original-foreign-host', directoryPath: directory, projectId: null }],
    zones: [{ zoneId: 'foreign-zone', workspaceId: 'foreign-workspace', kind: 'directory', hostId: 'original-foreign-host', directoryPath: directory, branch: null }],
    tabs: [], regions: [], bindings: [{ spaceId: 'foreign-space', zoneId: 'foreign-zone' }], layouts: {}, tabLayouts: {}, resources: {} } })
  const originalDesktopFailure = new AgentMuxError('The original foreign execution owner has an unavailable launch target.', 'ORIGINAL_FOREIGN_UNAVAILABLE')
  const desktopExecute = vi.fn(async () => { throw originalDesktopFailure })
  let host: AgentMuxRpcService
  const originalCore = vi.fn(async (_hostId, method, input, context) => host.call(method, input, context))
  const desktop = new AgentMuxRpcService({ coreClients: () => [], spatialState: spatial, callOriginalCore: originalCore, execute: desktopExecute })
  const forward = vi.fn(async (method, input, context) => {
    if (input.destination.zoneId !== 'foreign-zone') throw new AgentMuxError('This exact target has no original Desktop execution route.', 'FOREIGN_TARGET_UNKNOWN')
    return desktop.call(method, input, context)
  })
  const hostCreate = vi.fn(createHostSpatialAgentControl({ configurationPath: join(directory, 'unobserved-configuration.json'), spatial,
    runtime: () => { throw new Error('No unrelated Runtime is required to reject this exact target') } }))
  host = new AgentMuxRpcService({ coreClients: () => [], spatialState: spatial, spatialAgentControl: hostCreate, forwardControl: forward })
  cleanup.push(() => desktop.dispose(), () => host.dispose())
  const input = { operationId: 'original-foreign-operation', content: { kind: 'new-agent' as const, executorId: 'original' },
    destination: { spaceId: 'foreign-space', zoneId: 'foreign-zone', newTab: true }, focus: false }
  const context = { transport: 'relay' as const, principal: { kind: 'device' as const, id: 'original-device' } }
  await expect(host.call('agent.open', input, context)).rejects.toBe(originalDesktopFailure)
  expect(forward).toHaveBeenCalledExactlyOnceWith('agent.open', input, context)
  expect(desktopExecute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ requestId: input.operationId,
    destination: input.destination }), expect.objectContaining({ actor: { kind: 'device', id: 'original-device', verified: true } }), context)
  expect(originalCore).not.toHaveBeenCalled(); expect(hostCreate).not.toHaveBeenCalled()
  await expect(desktop.call('agent.open', { ...input, operationId: 'original-unknown-target',
    destination: { ...input.destination, zoneId: 'unobserved-zone' } }, context)).rejects.toMatchObject({ code: 'SPACE_TARGET_UNKNOWN' })
  expect(originalCore).toHaveBeenCalledTimes(1)
  expect(originalCore.mock.calls[0]![0]).toBe('local')
  expect(hostCreate).toHaveBeenCalledTimes(1)
  expect(forward).toHaveBeenCalledTimes(1); expect(desktopExecute).toHaveBeenCalledTimes(1)
})
