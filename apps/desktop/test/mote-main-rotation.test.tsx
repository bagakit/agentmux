// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxSpatialStateStore, spatialCatalog, spatialAgentOpenRecord, moteMainBaseline, AgentMuxError } from '@agentmux/core'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { RuntimeController } from '../src/main/runtime-controller'
import { pathToFileURL } from 'node:url'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { createHostSpatialAgentControl } from '../../host/src/spatial-agent-control'
import { createHostContent } from '../../host/src/content-owner'
import { createHostMoteMainReader, createHostMoteDialogue } from '../../host/src/mote-dialogue'
import { HostMoteQuickPreferences } from '../../host/src/mote-quick-preferences'
import { MoteDialogueStore } from '../../../packages/core/src/mote-dialogue-store'
import { ScratchTopics } from '../../host/src/mote-resources'
import { creationInputOwner } from '../../../packages/core/test/helpers/creation-input-owner'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { parseMoteQuickMode, serializeMoteQuickMode } from '../src/shared/mote-quick-mode'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { seedMoteWorkface } from './fixtures/mote-workface'
import { createMoteMain, continueMoteMainAction, inspectMoteMainAction, readMoteMainAction } from '../src/renderer/src/lib/mote-main-action'
import { MoteMainActions } from '../src/renderer/src/components/MoteMainActions'
import { MoteDialogueViewProvider } from '../src/renderer/src/lib/mote-dialogue-view'
import { agentMuxCommandHelp } from '../../../packages/core/src/agentmux-cli-help'
import { parseAgentMuxCliInvocation } from '../../../packages/core/src/agentmux-cli-commands'
import { rpcControlRequest } from '../../../packages/core/src/rpc-business-codec'
import { moteMainBindingInput, pendingMoteMainCreation } from '../../../packages/core/src/spatial-agent-open-contract'
import { moteQuickBaseline } from '../../../packages/core/src/mote-preferences'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service'
import { hostedTestOwner } from '../../../packages/core/test/helpers/hosted-runtime-port'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc'
import { parseMoteDialogueParams, parseMoteDialogueResult } from '../../../packages/core/src/mote-dialogue'


vi.mock('electron', () => ({ app: { isPackaged: false }, nativeImage: {} }))
const initialize = useAppStore.getState().initialize
const cleanups: Array<() => Promise<unknown> | unknown> = []
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const prior = useAppStore.getState(), dispose = await initialize(); dispose?.(); localStorage.clear(); seedMoteWorkface()
  cleanups.push(() => useAppStore.setState(prior, true))
})
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture(initialMain = false) {
  const h = await creationInputOwner(); cleanups.push(h.close)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mote-main-actions-'))); cleanups.push(() => rm(root, { recursive: true, force: true }))
  const workspace = { id: '__scratch__', hostId: 'local', path: join(root, 'scratch'), name: 'Original Scratch', kind: 'directory' as const }
  await mkdir(workspace.path)
  const topics = new ScratchTopics(), topic = await topics.ensureMote(workspace, 'launcher:main-action')
  const path = join(topic.physicalDirectoryPath!, 'MOTE.md'), spaceId = directoryIdentity('local', topic.identityDirectoryPath!), zoneId = homeZoneId(spaceId)
  const old = { hostId: 'local', sessionId: 'source', displayWorkspaceId: '__scratch__', groupId: 'original-group', tabId: 'old-tab', regionId: 'old-region' }
  const notes = '\n# Original cooperation notes\nKeep all my commitments.\n'
  await writeFile(path, serializeMoteQuickMode('', { executorId: 'saved', ...(initialMain ? { conversation: old } : {}) }) + notes)
  const graph = { spaces: [{ spaceId, kind: 'mote' as const, topicId: topic.id, name: 'Original Mote', hostId: 'local', directoryPath: topic.physicalDirectoryPath!, projectId: null }],
    zones: [{ zoneId, kind: 'home' as const, workspaceId: workspace.id, hostId: 'local', directoryPath: topic.physicalDirectoryPath!, branch: null }], bindings: [{ spaceId, zoneId }],
    tabs: [{ tabId: 'old-tab', workspaceId: workspace.id, zoneId, name: null, regionIds: ['old-region'] }],
    regions: [{ tabId: 'old-tab', regionId: 'old-region', kind: 'agent' as const, agentSessionId: 'source', runId: 'run-source', execution: { hostId: 'local', cwd: h.root } }],
    layouts: { __scratch__: { groups: [{ id: 'original-group', tabOrder: ['old-tab'], activeTabId: 'old-tab', recentTabIds: [] }], activeGroupId: 'original-group', root: { type: 'leaf' as const, groupId: 'original-group' } } },
    tabLayouts: { 'old-tab': { root: { type: 'leaf' as const, regionId: 'old-region' }, activeRegionId: 'old-region' } }, resources: { 'tab:old-tab': { draft: 'original-unsent-draft' } } }
  const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial.json')); await spatial.commit({ expectedRevision: 0, graph })
  const configurationPath = join(root, 'configuration.json')
  await writeFile(configurationPath, JSON.stringify({ workspaces: [workspace], executors: { saved: { label: 'Saved default', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: false } } }))
  const content = createHostContent({ configurationPath, spatial }), main = createHostMoteMainReader({ configurationPath, spatial, files: content.files! })
  const dialogue = createHostMoteDialogue({ main, spatial, store: new MoteDialogueStore(join(root, 'dialogue.sqlite')), clientForHost: () => h.client })
  const quick = new HostMoteQuickPreferences({ main, files: content.files!, recordMainSource: dialogue.recordMainSource,
    catalog: async () => spatialCatalog((await spatial.read())!.graph), executors: async () => [{ id: 'saved', name: 'Saved default', providerId: 'codex' }] })
  const creator = createHostSpatialAgentControl({ configurationPath, spatial, runtime: () => ({ client: h.client }) as never })
  const serviceOptions = { coreClients: h.coreClients, spatialState: spatial, spatialAgentControl: creator, moteDialogue: dialogue, moteQuickPreferences: quick }
  const service = new AgentMuxRpcService(serviceOptions)
  cleanups.push(() => service.dispose())
  const call = (method: any, params: any) => service.call(method, params, { transport: 'unix', principal: { kind: 'user', id: 'isolated-test-person' } }) as Promise<any>
  const read = vi.spyOn(api.motePreferences, 'read').mockImplementation(input => call('space.mote.preferences.read', input))
  const nativeSave = quick.save.bind(quick), save = vi.spyOn(quick,'save').mockImplementation(nativeSave)
  vi.spyOn(api.motePreferences,'save').mockImplementation(input => call('space.mote.preferences.save',input))
  const nativeLink = dialogue.link.bind(dialogue), link = vi.spyOn(dialogue,'link').mockImplementation(nativeLink)
  vi.spyOn(api.moteDialogue,'link').mockImplementation(input => call('space.mote.dialogue.link',input))
  vi.spyOn(api.moteDialogue,'inspectSetup').mockImplementation(input => call('space.mote.dialogue.setup.inspect',input))
  vi.spyOn(api.moteDialogue,'advanceSetup').mockImplementation(input => call('space.mote.dialogue.setup.advance',input))
  vi.spyOn(api.moteDialogue, 'read').mockImplementation(input => call('space.mote.dialogue.read', input))
  vi.spyOn(api.spatial, 'read').mockImplementation(() => spatial.read())
  const open = vi.spyOn(api.spatial, 'openAgent').mockImplementation(input => call('agent.open', input))
  vi.spyOn(api.sessions, 'creation').mockImplementation((_host, id) => h.client.inspectAgentCreation(id))
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue()
  const state = useAppStore.getState()
  useAppStore.setState({ config: { ...state.config!, workspaces: [workspace], executors: { saved: { label: 'Saved default', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: false } } },
    moteMainCreationReferences: {}, dirtyDocuments: {}, documentIssues: {}, spaceZoneBindings: { [zoneId]: { spaceId, workspaceId: workspace.id, topicId: topic.id, contentKind: 'mote' } } })
  useAppStore.setState({ refreshScratchTopics: vi.fn(async () => {}) })
  const scope = { workspace, topic, rootPath: topic.directoryPath! }, target = { spaceId, zoneId, expectedResource: { hostId: 'local', workspaceId: workspace.id, workspacePath: workspace.path } }
  const render = async (props: { entryToken?: string; active?: boolean } = {}) => {
    const element = document.createElement('div'); document.body.append(element); const root = createRoot(element)
    const configure = vi.fn(), created = vi.fn(), openCreated = vi.fn()
    const node = () => <MoteDialogueViewProvider scope={scope} active={props.active ?? true}><MoteMainActions scope={scope} active={props.active ?? true} entryToken={props.entryToken} onConfigure={configure} onCreated={created} onOpenCreated={openCreated} /></MoteDialogueViewProvider>
    await act(async () => { root.render(node()) }); cleanups.push(async () => { await act(async () => root.unmount()); element.remove() })
    return { element, configure, created, openCreated, remount: async () => { await act(async () => { root.render(null) }); await act(async () => { root.render(node()) }) } }
  }
  return { h, root, service, configurationPath, serviceOptions, spatial, scope, target, path, old, notes, call, read, save, link, open, quick, dialogue, render }
}
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 15000 }) }
async function click(element: HTMLElement, label: string) {
  const button = [...element.querySelectorAll('button')].find(item => item.textContent === label); expect(button, label).toBeDefined()
  await act(async () => button!.click())
}
it('actual Main action component reads without creating on hover/background and requires the MOTE configured default', async () => {
  const f = await fixture(), view = await f.render()
  await wait(() => expect(view.element.textContent).toContain('Create Main Agent'))
  expect(f.open).not.toHaveBeenCalled(); expect(f.h.started).toHaveLength(0)
  await writeFile(f.path, serializeMoteQuickMode('', {}))
  const missing = await readMoteMainAction(f.scope)
  expect(missing.issue).toContain('Choose a default Executor'); expect(missing.executor).toBeNull()
  await expect(createMoteMain(f.scope, missing)).rejects.toThrow('Choose a default Executor')
  expect(f.h.started).toHaveLength(0)
  await click(view.element, 'Configure default Executor'); expect(view.configure).toHaveBeenCalledOnce()
})
it('explicit unbound Discussion creates through original Core and binds exact original receipts, preserving old members and unsent work', async () => {
  const f = await fixture(), before = (await f.spatial.read())!, view = await f.render({ entryToken: 'human-open-1' })
  await wait(() => expect(view.element.textContent).toContain('binding confirmed'))
  const reading = await readMoteMainAction(f.scope), reference = reading.dialogue.main.current!
  expect(reference).toMatchObject({ hostId: 'local' }); expect(reference.sessionId).not.toBe('source')
  expect(f.open).toHaveBeenCalledTimes(1); expect(f.open.mock.calls[0]![0].content).toEqual({ kind: 'new-agent', executorId: 'saved' })
  expect(f.h.started).toHaveLength(1); expect(f.save).toHaveBeenCalledTimes(1); expect(f.link).not.toHaveBeenCalled()
  const original = (await f.spatial.read())!
  expect(original.graph.regions).toContainEqual(before.graph.regions[0]); expect(original.graph.resources['tab:old-tab']).toEqual({ draft: 'original-unsent-draft' })
  expect(original.graph.layouts.__scratch__!.groups[0]!.activeTabId).toBe('old-tab')
  expect(JSON.stringify(original.graph.resources['core:agent-open'])).not.toContain('Keep all my commitments.')
  expect(await readFile(f.path, 'utf8')).toContain(f.notes)
  expect(view.created).toHaveBeenCalledWith(reference); expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
  expect(Object.values(JSON.parse(localStorage.getItem('agentmux-workbench-v1')!).state.moteMainCreationReferences)).toEqual([{ target: f.target, operationId: f.open.mock.calls[0]![0].operationId }])
  await view.remount(); await wait(() => expect(view.element.textContent).toContain('binding confirmed'))
  expect(f.open).toHaveBeenCalledTimes(1); expect(f.h.started).toHaveLength(1)
})
it('A to B rotation keeps the exact old Main source and Core Run, without moving later user selection', async () => {
  const f = await fixture(true), oldSession = await f.h.client.inspectAgentCreation('source'), reading = await readMoteMainAction(f.scope)
  const before = useAppStore.getState().workbenchSpaceSelection
  const value = await createMoteMain(f.scope, reading)
  expect(value).toMatchObject({ creation: 'confirmed', source: 'confirmed', binding: 'confirmed', issue: null })
  const page = await f.call('space.mote.dialogue.read', { target: f.target })
  expect(page.links.filter((link: any) => link.kind === 'main').map((link: any) => link.reference.sessionId)).toEqual(expect.arrayContaining(['source', value.reference!.sessionId]))
  expect((await f.h.client.inspectAgentCreation('source')).run).toEqual(oldSession.run)
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(before)
  expect(f.h.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.h.rawInput).not.toHaveBeenCalled()
  expect(f.link).toHaveBeenCalledOnce(); expect(f.save).toHaveBeenCalledOnce()
})
it('a lost original creation reply survives remount and only inspection, before explicit continuation of the original setup', async () => {
  const f = await fixture(), nativeOpen = f.open.getMockImplementation()!
  f.open.mockImplementationOnce(async input => { await nativeOpen(input); throw new Error('Original transport ACK lost') })
  const view = await f.render({ entryToken: 'open-lost-reply' })
  await wait(() => expect(view.element.textContent).toContain('Original creation unconfirmed'))
  expect(f.h.started).toHaveLength(1); expect(f.save).not.toHaveBeenCalled()
  const reference = Object.values(useAppStore.getState().moteMainCreationReferences)[0]!
  const encoded = JSON.parse(localStorage.getItem('agentmux-workbench-v1')!)
  expect(encoded.state.moteMainCreationReferences[JSON.stringify(f.target)]).toEqual(reference)
  useAppStore.setState({ moteMainCreationReferences: {} })
  await useAppStore.persist.rehydrate()
  expect(useAppStore.getState().moteMainCreationReferences[JSON.stringify(f.target)]).toEqual(reference)
  await view.remount()
  await wait(() => expect(view.element.textContent).toContain('Creation: confirmed'))
  expect(f.open).toHaveBeenCalledTimes(1); expect(f.h.started).toHaveLength(1); expect(f.save).not.toHaveBeenCalled()
  await click(view.element, 'Continue original setup')
  await wait(() => expect(view.element.textContent).toContain('binding confirmed'))
  expect(f.open).toHaveBeenCalledTimes(1); expect(f.h.started).toHaveLength(1); expect(f.save).toHaveBeenCalledTimes(1)
})
it('unknown old-source ACK is inspected on its original operation, without relinking or rebinding from a read', async () => {
  const f = await fixture(true), nativeLink = f.link.getMockImplementation()!
  f.link.mockImplementationOnce(async input => { await nativeLink(input); throw new Error('Original source ACK lost') })
  const value = await createMoteMain(f.scope, await readMoteMainAction(f.scope))
  expect(value).toMatchObject({ creation: 'confirmed', binding: 'unconfirmed' }); expect(f.save).not.toHaveBeenCalled()
  const inspected = await inspectMoteMainAction(f.scope, value.operationId)
  expect(inspected.source).toBe('confirmed'); expect(inspected.binding).toBe('unconfirmed'); expect(f.link).toHaveBeenCalledTimes(1)
  expect(f.save).not.toHaveBeenCalled()
  const resumed = await continueMoteMainAction(f.scope, value.operationId)
  expect(resumed.binding).toBe('confirmed'); expect(f.link).toHaveBeenCalledTimes(1); expect(f.save).toHaveBeenCalledTimes(1)
})
it('unknown binding ACK is read by the exact writer-derived role revision and never saved twice', async () => {
  const f = await fixture(true), nativeSave = f.save.getMockImplementation()!
  f.save.mockImplementationOnce(async input => { await nativeSave(input); throw new Error('Original binding ACK lost') })
  const value = await createMoteMain(f.scope, await readMoteMainAction(f.scope))
  expect(value).toMatchObject({ creation: 'confirmed', source: 'confirmed', binding: 'unconfirmed' })
  const read = await inspectMoteMainAction(f.scope, value.operationId)
  expect(read.binding).toBe('confirmed'); expect(f.save).toHaveBeenCalledTimes(1); expect(f.open).toHaveBeenCalledTimes(1)
  expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
})
it('a later role generation wins CAS; the newly created B and earlier source A remain usable', async () => {
  const f = await fixture(true), nativeSave = f.save.getMockImplementation()!
  f.save.mockImplementationOnce(async input => {
    const current = parseMoteQuickMode(await readFile(f.path, 'utf8'))
    if (current.status !== 'valid') throw new Error('Original baseline required')
    await writeFile(f.path, serializeMoteQuickMode(await readFile(f.path, 'utf8'), { ...current.defaults, conversationRevision: 'later-human-role' }))
    return nativeSave(input)
  })
  const value = await createMoteMain(f.scope, await readMoteMainAction(f.scope))
  expect(value).toMatchObject({ creation: 'confirmed', source: 'confirmed', binding: 'refused' })
  expect((await readMoteMainAction(f.scope)).dialogue.main).toMatchObject({ current: f.old, roleRevision: 'later-human-role' })
  expect((await f.h.client.inspectAgentCreation(value.reference!.sessionId)).run.runId).toBeTruthy()
  const source = await f.call('space.mote.dialogue.read', { target: f.target, operationId: value.operationId + ':source' })
  expect(source.links).toMatchObject([{ kind: 'main', reference: f.old }])
  expect(f.h.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.h.started).toHaveLength(1)
})
it('a saved role remains confirmed when the original post-save source journal is unavailable', async () => {
  const f = await fixture(true)
  vi.spyOn(f.dialogue, 'recordMainSource').mockRejectedValue(new Error('Source journal unavailable after File save'))
  // The real writer is configured with this port; only its source append is unavailable.
  const ports = (f.quick as unknown as { ports: { recordMainSource: typeof f.dialogue.recordMainSource } }).ports
  ports.recordMainSource = f.dialogue.recordMainSource
  const value = await createMoteMain(f.scope, await readMoteMainAction(f.scope))
  expect(value.binding).toBe('confirmed'); expect(value.issue).toContain('Settings were saved')
  expect(value.source).toBe('confirmed')
  const source = await f.call('space.mote.dialogue.read', { target: f.target, operationId: value.operationId + ':source' })
  expect(source.links).toMatchObject([{ kind: 'main', reference: f.old }]); expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
})
it('two original clients share one atomic creation admission and each follow-up is claimed only once', async () => {
  const f = await fixture(), reading = await readMoteMainAction(f.scope)
  const baseline = { resource: reading.preferences.source!.resource!, document: reading.preferences.source!.result.status === 'read' ? reading.preferences.source!.result.document : null, defaults: reading.preferences.defaults! }
  const request = { operationId: reading.operationId!, content: { kind: 'new-agent' as const, executorId: 'saved' }, destination: { spaceId: f.target.spaceId, zoneId: f.target.zoneId, newTab: true as const }, focus: false,
    moteMain: { target: f.target, baseline: moteMainBaseline(baseline), expectedRoleRevision: reading.dialogue.main.roleRevision, sourceOperationId: reading.operationId + ':source', bindOperationId: reading.operationId + ':bind' } }
  const [one, two] = await Promise.all([f.call('agent.open', request), f.call('agent.open', structuredClone(request))])
  const record = spatialAgentOpenRecord((await f.spatial.read())!.graph, request.operationId)!
  expect(record).toMatchObject({ moteMain: request.moteMain })
  expect(f.h.started).toHaveLength(1); expect(new Set([one.agent?.agentSessionId, two.agent?.agentSessionId].filter(Boolean))).toEqual(new Set([record.agentSessionId]))
  const claims = await Promise.all([new AgentMuxSpatialStateStore(f.spatial.path).claimMoteMainFollowUp({ requestId: request.operationId, step: 'binding' }),
    new AgentMuxSpatialStateStore(f.spatial.path).claimMoteMainFollowUp({ requestId: request.operationId, step: 'binding' })])
  expect(claims.filter(value => value.claimed)).toHaveLength(1)
  const reloaded = spatialAgentOpenRecord((await new AgentMuxSpatialStateStore(f.spatial.path).read())!.graph, request.operationId)!
  expect(reloaded.moteMainFollowUps?.bindStarted).toBe(true)
})
it('actual CLI and public schema retain the same original metadata; wrong Host/default cannot dispatch', async () => {
  const f = await fixture(), value = await createMoteMain(f.scope, await readMoteMainAction(f.scope))
  expect(value.binding).toBe('confirmed')
  const request = f.open.mock.calls[0]![0], file = join(f.root, 'original-main-intent.json'); await writeFile(file, JSON.stringify(request.moteMain))
  const parsed = await parseAgentMuxCliInvocation(['agent','open','--executor','saved','--space',f.target.spaceId,'--zone',f.target.zoneId,'--new-tab','--operation-id',value.operationId,'--mote-main',file])
  expect(parsed.command.method).toBe('agent.open'); expect(parsed.params).toEqual(request)
  expect(agentMuxCommandHelp('agent.open')).toContain('--mote-main'); expect(agentMuxCommandHelp('agent.open')).toContain('does not appoint Main')
  expect((rpcControlRequest('agent.open', parsed.params) as any).moteMain).toEqual(request.moteMain)
  const result = await f.call(parsed.command.method, parsed.params)
  expect(result.agent.agentSessionId).toBe(value.reference!.sessionId); expect(f.h.started).toHaveLength(1)
  const server = new AgentMuxControlServer({ ...f.serviceOptions, socketPath: join(f.root, 'actual-cli.sock') }); await server.start(); cleanups.push(() => server.stop())
  const loader = pathToFileURL(join(process.cwd(), 'packages/core/test/fixtures/a2a-resumed-inbox/source-loader.mjs'))
  const registration = `import { register } from 'node:module'; register(${JSON.stringify(loader.href)}, ${JSON.stringify(pathToFileURL(join(process.cwd(),'packages/core/src/agentmux.ts')).href)});`
  const cli = await new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject) => {
    const child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(registration), join(process.cwd(),'packages/core/src/agentmux.ts'),
      '--endpoint', 'unix://' + server.path, 'agent','open','--executor','saved','--space',f.target.spaceId,'--zone',f.target.zoneId,'--new-tab','--operation-id',value.operationId,'--mote-main',file],
      { env: { ...process.env, AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined }, stdio: ['ignore','pipe','pipe'] })
    let stdout='',stderr=''
    const timer=setTimeout(()=>{child.kill();reject(new Error('Private source CLI observation timed out'))},30000)
    child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value)
    child.on('error',error=>{clearTimeout(timer);reject(error)});child.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr})})
  })
  expect(cli.code, cli.stdout + cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result.agent.agentSessionId).toBe(value.reference!.sessionId)
  expect(f.h.started).toHaveLength(1)
  await expect(f.service.call('agent.open', { ...request, operationId: 'agent-main-claim' }, { transport: 'unix', principal: {kind:'user',id:'actual-person'},
    caller: { agentSessionId:'source',capability:f.h.capability } })).rejects.toMatchObject({code:'CONTROL_PERMISSION_DENIED',message:expect.stringContaining('Main creation setup requires')})
  await expect(f.call('agent.open', { ...request, operationId: 'wrong-default', content: { kind: 'new-agent', executorId: 'codex' } })).rejects.toThrow('configured default')
  await expect(f.call('agent.open', { ...request, operationId: 'wrong-host', moteMain: { ...request.moteMain, target: { ...f.target, expectedResource: { ...f.target.expectedResource, hostId: 'foreign' } }, baseline: { ...request.moteMain!.baseline, resource: { ...request.moteMain!.baseline.resource, hostId: 'foreign' } } } })).rejects.toMatchObject({ code: 'SPACE_RESOURCE_CHANGED' })
  expect(f.h.started).toHaveLength(1)
})
it('an explicit unknown File write remains unconfirmed and is never promoted to Main by the consumer', async () => {
  const f = await fixture(), ports = (f.quick as any).ports
  vi.spyOn(ports.files, 'write').mockImplementationOnce(async (...args: any[]) => ({ resource: args[0].expectedResource,
    result: { status: 'unknown', code: 'WRITE_UNCONFIRMED', message: 'Original File write result unknown' } }))
  const value = await createMoteMain(f.scope, await readMoteMainAction(f.scope))
  expect(value).toMatchObject({ creation: 'confirmed', binding: 'unconfirmed' })
  expect((await readMoteMainAction(f.scope)).dialogue.main.current).toBeNull()
  await inspectMoteMainAction(f.scope, value.operationId)
  expect(f.save).toHaveBeenCalledTimes(1); expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
})
it('another client with no pointer inherits the unbound original creation across default/revision edits, then a refused CAS releases only that claim', async () => {
  const f = await fixture(), nativeOpen = f.open.getMockImplementation()!
  f.open.mockImplementationOnce(async input => { await nativeOpen(input); throw new Error('First client lost original ACK') })
  const initial = await createMoteMain(f.scope, await readMoteMainAction(f.scope))
  expect(initial.creation).toBe('unconfirmed'); expect(f.h.started).toHaveLength(1)
  const originalRef = structuredClone(useAppStore.getState().moteMainCreationReferences)
  useAppStore.setState({ moteMainCreationReferences: {} }) // independent second-client pointer snapshot
  const configuration = JSON.parse(await readFile(f.configurationPath, 'utf8'))
  configuration.executors.replacement = { ...configuration.executors.saved, label: 'New configured default' }
  await writeFile(f.configurationPath, JSON.stringify(configuration))
  ;(f.quick as any).ports.executors = async () => [{ id: 'saved', name: 'Saved default', providerId: 'codex' }, { id: 'replacement', name: 'New configured default', providerId: 'codex' }]
  await writeFile(f.path, serializeMoteQuickMode(await readFile(f.path, 'utf8'), { executorId: 'replacement' }) + '\nUnrelated notes changed by the person.\n')
  const second = await readMoteMainAction(f.scope)
  expect(second.operationId).not.toBe(initial.operationId); expect(second.pendingOperationId).toBe(initial.operationId)
  expect(second.executor?.id).toBe('replacement')
  const baseline = { resource: second.preferences.source!.resource!, document: second.preferences.source!.result.status === 'read' ? second.preferences.source!.result.document : null, defaults: second.preferences.defaults! }
  await expect(f.call('agent.open', { operationId: second.operationId, content: { kind: 'new-agent', executorId: 'replacement' },
    destination: { spaceId: f.target.spaceId, zoneId: f.target.zoneId, newTab: true }, focus: false,
    moteMain: { target: f.target, baseline: moteMainBaseline(baseline), expectedRoleRevision: second.dialogue.main.roleRevision, sourceOperationId: second.operationId + ':source', bindOperationId: second.operationId + ':bind' } }))
    .rejects.toMatchObject({ code: 'MOTE_MAIN_CREATION_PENDING', detail: JSON.stringify({ operationId: initial.operationId, target: f.target }) })
  const view = await f.render({ entryToken: 'second-client-explicit-open' })
  await wait(() => expect(view.element.textContent).toContain(initial.operationId))
  expect(f.h.started).toHaveLength(1); expect(f.open).toHaveBeenCalledTimes(1); expect(f.save).not.toHaveBeenCalled()
  const oldAgent = spatialAgentOpenRecord((await f.spatial.read())!.graph, initial.operationId)!.agentSessionId
  await click(view.element, 'Continue original setup')
  await wait(() => expect(view.element.textContent).toContain('Main binding: refused'))
  expect((await f.h.client.inspectAgentCreation(oldAgent)).kind).toBe('agent')
  expect(view.openCreated).not.toHaveBeenCalled()
  await click(view.element, 'Open created Agent')
  expect(view.openCreated).toHaveBeenCalledWith(expect.objectContaining({hostId:'local',sessionId:oldAgent}))
  expect(f.h.started).toHaveLength(1)
  await click(view.element, 'Create Main Agent')
  await wait(() => expect(view.created).toHaveBeenCalledOnce())
  expect(f.h.started).toHaveLength(2)
  expect(view.created.mock.calls[0]![0].sessionId).not.toBe(oldAgent)
  expect(Object.values(originalRef)[0]!.operationId).toBe(initial.operationId)
  expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
})
it('the same mounted component can rotate immediately after its first automatic Main without a manual reread', async () => {
  const f = await fixture(), view = await f.render({ entryToken: 'same-mount-open' })
  await wait(() => expect(view.created).toHaveBeenCalledOnce())
  const first = view.created.mock.calls[0]![0], run = (await f.h.client.inspectAgentCreation(first.sessionId)).run
  await wait(() => expect([...view.element.querySelectorAll('button')].find(item => item.textContent === 'New Main Agent')?.disabled).toBe(false))
  await click(view.element, 'New Main Agent')
  await wait(() => expect(view.created).toHaveBeenCalledTimes(2))
  const next = view.created.mock.calls[1]![0]
  expect(next.sessionId).not.toBe(first.sessionId); expect(f.open).toHaveBeenCalledTimes(2); expect(f.h.started).toHaveLength(2)
  expect(f.open.mock.calls[1]![0].operationId).not.toBe(f.open.mock.calls[0]![0].operationId)
  expect((await f.h.client.inspectAgentCreation(first.sessionId)).run).toEqual(run)
  const history = await f.call('space.mote.dialogue.read', { target: f.target })
  expect(history.links.some((link: any) => link.kind === 'main' && link.reference.sessionId === first.sessionId)).toBe(true)
  expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
})
it('the original Desktop spatial and Session subscriptions expose the created B without replacing its Core identity', async () => {
  const f = await fixture(), state = useAppStore.getState(), config = { ...state.config!, hosts: [{ id: 'local', kind: 'local' as const, label: 'Private local Host' }] }
  const controller = new RuntimeController(f.h.store, async () => f.h.client)
  controller.commit(await controller.prepare(config))
  cleanups.push(() => controller.dispose())
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.spatial, 'commit').mockImplementation(input => f.spatial.commit(input))
  const desktopSpatialOwner = new AgentMuxSpatialStateStore(f.spatial.path)
  const subscribed = vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => desktopSpatialOwner.subscribe(listener))
  let snapshotCompleted = 0
  vi.spyOn(api.sessions, 'snapshot').mockImplementation(async () => { const result = await controller.snapshot(config); snapshotCompleted++; return result })
  const delivered: any[] = []
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(listener => {
    const webContents = Object.assign(new EventEmitter(), { id: 901, isDestroyed: () => false,
      send(channel: string, event: any) { delivered.push({ channel, event }); listener(event) } })
    return controller.attach(webContents as never)
  })
  vi.spyOn(api.scratch, 'listTopics').mockImplementation(() => new ScratchTopics().list(f.scope.workspace))
  useAppStore.setState({ loading: true, sessions: [], scratchTopicSnapshots: {}, workbenchSpaceSelection: null })
  const dispose = await initialize(); cleanups.push(dispose!)
  await wait(() => expect(snapshotCompleted).toBeGreaterThan(0))
  const view = await f.render({ entryToken: 'live-original-desktop-owner' })
  await wait(() => expect(view.created).toHaveBeenCalledOnce())
  const reference = view.created.mock.calls[0]![0]
  await wait(() => {
    const tab = useAppStore.getState().tabs[reference.tabId], region = tab?.regions[reference.regionId]
    expect(region).toMatchObject({ kind: 'agent', sessionId: reference.sessionId })
    const session = useAppStore.getState().sessions.find(item => item.kind === 'agent' && item.control.agentSessionId === reference.sessionId)
    expect(session).toMatchObject({ kind: 'agent', control: { hostId: reference.hostId, agentSessionId: reference.sessionId } })
  })
  const original = await f.h.client.inspectAgentCreation(reference.sessionId)
  expect(useAppStore.getState().sessions.find(item => item.kind === 'agent' && item.control.agentSessionId === reference.sessionId)?.control.run).toEqual(original.run)
  expect(subscribed).toHaveBeenCalledOnce(); expect(delivered.length).toBeGreaterThan(0)
  expect(f.h.started).toHaveLength(1); expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
})
it('later human reading or input cancels only the late automatic Main navigation, while original creation and binding finish', async () => {
  const f = await fixture(), start = f.h.inner.kernel.start.getMockImplementation()!
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  f.h.inner.kernel.start.mockImplementationOnce(async (input: any) => { await gate; return start(input) })
  const view = await f.render({ entryToken: 'late-human-open' })
  await wait(() => expect(f.h.inner.kernel.start).toHaveBeenCalledOnce())
  await act(async () => { document.dispatchEvent(new Event('wheel', { bubbles: true })); release() })
  await wait(() => expect(view.element.textContent).toContain('binding confirmed'))
  await wait(() => expect(view.element.querySelector('[aria-label="Main Agent actions"]')?.getAttribute('aria-busy')).toBe('false'))
  expect(view.created).not.toHaveBeenCalled()
  expect((await readMoteMainAction(f.scope)).dialogue.main.current?.sessionId).toBeTruthy()
  expect(f.h.started).toHaveLength(1); expect(f.save).toHaveBeenCalledTimes(1); expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
})

async function originalAdmission(f: Awaited<ReturnType<typeof fixture>>) {
  const reading = await readMoteMainAction(f.scope), operationId = reading.operationId!, baseline = moteQuickBaseline(reading.preferences)!
  await f.call('agent.open',{operationId,content:{kind:'new-agent',executorId:reading.executor!.id},destination:{spaceId:f.target.spaceId,zoneId:f.target.zoneId,newTab:true},focus:false,
    moteMain:{target:f.target,baseline:moteMainBaseline(baseline),expectedRoleRevision:reading.dialogue.main.roleRevision,sourceOperationId:operationId+':source',bindOperationId:operationId+':bind'}})
  const record = spatialAgentOpenRecord((await f.spatial.read())!.graph,operationId)!
  return {input:{target:f.target,creation:{hostId:'local',operationId}},record,baseline}
}
async function publicEndpoint(f: Awaited<ReturnType<typeof fixture>>) {
  const runtime = new AgentMuxHostedRuntimeService(f.h.client,f.h.store.path,()=>hostedTestOwner(f.h.client))
  const server = new AgentMuxControlServer({...f.serviceOptions,hostedRuntime:()=>runtime,socketPath:join(f.root,'public-setup.sock')})
  await server.start(); cleanups.push(()=>server.stop())
  const rpc = await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}});cleanups.push(()=>rpc.dispose())
  const hosted = await connectHostedAgentMux({rpc,waitForReady:false,forwardRpc:(method,params,context)=>rpc.call(method,params,context)})
  cleanups.push(()=>hosted.dispose())
  const cli = async (args:string[],input?:unknown) => {
    const loader=pathToFileURL(join(process.cwd(),'packages/core/test/fixtures/a2a-resumed-inbox/source-loader.mjs'))
    const registration=`import { register } from 'node:module'; register(${JSON.stringify(loader.href)}, ${JSON.stringify(pathToFileURL(join(process.cwd(),'packages/core/src/agentmux.ts')).href)});`
    const result=await new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{
      const child=spawn(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(registration),join(process.cwd(),'packages/core/src/agentmux.ts'),'--endpoint','unix://'+server.path,...args],{env:objectCliEnvironment(f.root),stdio:['pipe','pipe','pipe']})
      let stdout='',stderr='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Original source CLI timed out'))},30000)
      child.stdout.on('data',part=>stdout+=part);child.stderr.on('data',part=>stderr+=part)
      child.once('error',error=>{clearTimeout(timer);reject(error)});child.once('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr})})
      child.stdin.end(input===undefined?'':JSON.stringify(input))
    })
    expect(result.code,result.stdout+result.stderr).toBe(0);return JSON.parse(result.stdout).result
  }
  return {rpc,hosted,cli}
}
it('public setup actual Unix CLI and Hosted SDK share original stages; inspect is pure and advance never creates',async()=>{
  const f=await fixture(true), admission=await originalAdmission(f), endpoint=await publicEndpoint(f), before=await readFile(f.spatial.path,'utf8'), file=await readFile(f.path,'utf8')
  const inputFile=join(f.root,'setup-input.json');await writeFile(inputFile,JSON.stringify(admission.input))
  expect(agentMuxCommandHelp('space.mote.dialogue.setup.inspect')).toContain('--input FILE|-')
  const observed=await endpoint.cli(['space','mote','dialogue','setup','inspect','--input',inputFile])
  expect(observed).toMatchObject({operationId:admission.record.requestId,ownerHostId:'local',creation:'confirmed',source:'unconfirmed',binding:'unconfirmed'})
  expect(await readFile(f.spatial.path,'utf8')).toBe(before);expect(await readFile(f.path,'utf8')).toBe(file);expect(f.save).not.toHaveBeenCalled();expect(f.link).not.toHaveBeenCalled()
  const value=await endpoint.hosted.forwardRpc!('space.mote.dialogue.setup.advance',admission.input)
  expect(value).toMatchObject({creation:'confirmed',source:'confirmed',binding:'confirmed',bindingReceipt:{status:'saved',operationId:admission.record.moteMain!.bindOperationId}})
  const repeat=await endpoint.cli(['space','mote','dialogue','setup','advance','--input','-'],admission.input)
  expect(repeat.reference).toEqual(value.reference);expect(f.h.started).toHaveLength(1);expect(f.save).toHaveBeenCalledOnce();expect(f.link).toHaveBeenCalledOnce();expect(f.h.rawInput).not.toHaveBeenCalled();expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
})
it('independent actual CLI preferences save settles only its complete original binding and releases initial admission',async()=>{
  const f=await fixture(), admission=await originalAdmission(f), endpoint=await publicEndpoint(f), binding=moteMainBindingInput(admission.record,admission.baseline)
  const saved=await endpoint.cli(['space','mote','preferences','save','--input','-'],binding)
  expect(saved.status).toBe('saved')
  const graph=(await f.spatial.read())!.graph,record=spatialAgentOpenRecord(graph,admission.record.requestId)!
  expect(record.moteMainFollowUps?.bindingReceipt).toMatchObject({operationId:binding.operationId,status:'saved',source:{defaults:binding.values}})
  expect(pendingMoteMainCreation(graph,f.target)).toBeNull()
  expect(await endpoint.hosted.forwardRpc!('space.mote.dialogue.setup.inspect',admission.input)).toMatchObject({binding:'confirmed'})
  expect(f.h.started).toHaveLength(1);expect(f.save).toHaveBeenCalledOnce()
})
it('matching bind operation ID alone cannot certify another target role or occurrence writer result',async()=>{
  const f=await fixture(), admission=await originalAdmission(f), endpoint=await publicEndpoint(f), binding=moteMainBindingInput(admission.record,admission.baseline)
  const {hostId:_,sessionId:__,...location}=f.old
  const changed={...binding,values:{...binding.values,conversation:f.old},destination:{kind:'occurrence' as const,...location}}
  expect((await endpoint.cli(['space','mote','preferences','save','--input','-'],changed)).status).toBe('saved')
  expect(spatialAgentOpenRecord((await f.spatial.read())!.graph,admission.record.requestId)!.moteMainFollowUps?.bindingReceipt).toBeUndefined()
  expect(pendingMoteMainCreation((await f.spatial.read())!.graph,f.target)?.requestId).toBe(admission.record.requestId)
  expect(await endpoint.hosted.forwardRpc!('space.mote.dialogue.setup.advance',admission.input)).toMatchObject({binding:'refused'})
  expect(f.h.started).toHaveLength(1);expect(f.save).toHaveBeenCalledOnce()
})
it('public setup refuses managed callers and forged fields, while wrong targets and missing owners retain original work',async()=>{
  const f=await fixture(), admission=await originalAdmission(f),before=await readFile(f.spatial.path,'utf8')
  await expect(f.service.call('space.mote.dialogue.setup.advance',admission.input,{transport:'unix',principal:{kind:'user',id:'person'},caller:{agentSessionId:'source',capability:f.h.capability}})).rejects.toMatchObject({code:'CONTROL_PERMISSION_DENIED'})
  expect(()=>parseMoteDialogueParams('space.mote.dialogue.setup.advance',{...admission.input,saved:{status:'saved'}})).toThrow()
  expect(()=>parseMoteDialogueParams('space.mote.dialogue.setup.inspect',{...admission.input,creation:{...admission.input.creation,executionHostId:'local'}})).toThrow()
  const wrong=await f.call('space.mote.dialogue.setup.advance',{...admission.input,target:{...f.target,spaceId:'different-mote'}})
  expect(wrong).toMatchObject({creation:'unconfirmed',binding:'unconfirmed',record:null,reference:null})
  await expect(f.call('space.mote.dialogue.setup.advance',{...admission.input,creation:{...admission.input.creation,hostId:'absent-owner'}})).rejects.toMatchObject({code:'CONTROL_UNAVAILABLE'})
  expect(await readFile(f.spatial.path,'utf8')).toBe(before);expect(f.h.started).toHaveLength(1);expect(f.save).not.toHaveBeenCalled()
  const valid=await f.call('space.mote.dialogue.setup.advance',admission.input)
  expect(()=>parseMoteDialogueResult('space.mote.dialogue.setup.advance',{...valid,ownerHostId:'other-owner'},admission.input)).toThrow()
  expect(valid.binding).toBe('confirmed');expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
})
it('public setup routes the original admission Host independently from resource and execution Hosts, without remapping opaque facts',async()=>{
  const f=await fixture(), admission=await originalAdmission(f),endpoint=await publicEndpoint(f)
  const decoy=vi.fn(async()=>{throw Error('Replacement Host must never receive the original operation')})
  const forwarded:any[]=[]
  const remote={...f.h.client,forwardRpc:async(method:any,params:any,context:any)=>{forwarded.push({method,params:structuredClone(params)});return endpoint.rpc.call(method,params,context)}}
  const aggregate=new AgentMuxRpcService({coreClients:()=>[{hostId:'original-admission',client:remote as never},{hostId:'local',client:{forwardRpc:decoy} as never}]});cleanups.push(()=>aggregate.dispose())
  const input={...admission.input,creation:{...admission.input.creation,hostId:'original-admission'}}
  const value=await aggregate.call('space.mote.dialogue.setup.advance',input,{transport:'unix',principal:{kind:'user',id:'original-person'}})
  expect(value).toMatchObject({ownerHostId:'original-admission',creation:'confirmed',binding:'confirmed'})
  expect(forwarded).toEqual([{method:'space.mote.dialogue.setup.advance',params:{...input,creation:{...input.creation,hostId:'local'}}}])
  expect(value.record?.moteMain?.target).toEqual(admission.input.target);expect(value.reference?.hostId).toBe('local');expect(decoy).not.toHaveBeenCalled();expect(f.h.started).toHaveLength(1)
})
it('a native File result remains confirmed when admission retention fails; inspect is pure and explicit original reconciliation releases it',async()=>{
  const f=await fixture(), admission=await originalAdmission(f), retain=vi.spyOn(f.spatial,'recordMoteMainBindingResult').mockRejectedValue(Error('Original metadata disk unavailable'))
  const value=await f.call('space.mote.dialogue.setup.advance',admission.input)
  expect(value).toMatchObject({binding:'confirmed',bindingReceipt:{status:'saved'},record:{moteMainFollowUps:{bindStarted:true}}})
  expect(value.issue).toContain('retention is unconfirmed');expect(value.record.moteMainFollowUps.bindingReceipt).toBeUndefined()
  const before=await readFile(f.spatial.path,'utf8'),inspected=await f.call('space.mote.dialogue.setup.inspect',admission.input)
  expect(inspected).toMatchObject({binding:'confirmed',bindingReceipt:null,bindingObserved:{kind:'preferences',source:{defaults:expect.objectContaining({conversation:value.reference})}}})
  expect(await readFile(f.spatial.path,'utf8')).toBe(before);expect(pendingMoteMainCreation((await f.spatial.read())!.graph,f.target)).not.toBeNull()
  retain.mockRestore()
  const continued=await f.call('space.mote.dialogue.setup.advance',admission.input)
  expect(continued).toMatchObject({binding:'confirmed',bindingReceipt:null,record:{moteMainFollowUps:{bindingObserved:inspected.bindingObserved}}})
  expect(pendingMoteMainCreation((await f.spatial.read())!.graph,f.target)).toBeNull();expect(f.h.started).toHaveLength(1);expect(f.save).toHaveBeenCalledOnce()
})
it('a separate resource protocol Host receives frozen source and CAS keys; unknown foreign binding is inspected without local fallback',async()=>{
  const f=await fixture(), actual=await originalAdmission(f), foreign='original-files-owner', target={...f.target,expectedResource:{...f.target.expectedResource,hostId:foreign}}, originalRead=structuredClone(await f.quick.read({kind:'quick',target:f.target}))
  // This route oracle supplies a second Host's exact resource protocol. Real local Files CAS is covered above.
  const read={...originalRead,target,source:{...originalRead.source!,resource:{...originalRead.source!.resource!,hostId:foreign}}}
  const baseline=moteQuickBaseline(read)!, spatial=new AgentMuxSpatialStateStore(join(f.root,'other-admission.json')), graph=structuredClone((await f.spatial.read())!.graph)
  delete graph.resources['core:agent-open'];graph.zones[0]!.hostId=foreign;graph.spaces[0]!.hostId=foreign
  await spatial.commit({expectedRevision:0,graph})
  const intent={...actual.record.moteMain!,target,baseline:moteMainBaseline(baseline)}
  const admitted=await spatial.admitAgentOpen({request:{operation:'agent.open',requestId:actual.record.requestId,content:{kind:'new-agent',executorId:'saved'},destination:{spaceId:target.spaceId,zoneId:target.zoneId,newTab:true},focus:false,moteMain:intent},agentSessionId:actual.record.agentSessionId,execution:{...actual.record.execution,hostId:foreign},regionResource:{}})
  const main={target,identity:{hostId:foreign,moteId:f.scope.topic.id},status:'ready' as const,resource:baseline.resource,documentRevision:baseline.document!.revision,roleRevision:actual.record.moteMain!.expectedRoleRevision,current:null,issue:null}
  const remoteRead=vi.fn(async(input:any)=>{expect(input.target).toEqual(target);return read})
  const remoteSources=vi.fn(async(input:any)=>{expect(input.target).toEqual(target);return {main,links:[],incarnation:null,throughSequence:0,next:null,coverage:'linked-sources-only' as const,sourceStatus:'read' as const,sourceIssue:null}})
  const remoteSave=vi.fn(async(input:any)=>{expect(input).toEqual(moteMainBindingInput(admitted.record,baseline));return {kind:'quick' as const,target,operationId:input.operationId,status:'unconfirmed' as const,source:null,message:'Original foreign File outcome unknown'}})
  const resource=new AgentMuxControlServer({socketPath:join(f.root,'foreign-resource.sock'),moteQuickPreferences:{read:remoteRead,save:remoteSave},moteDialogue:{read:remoteSources,link:vi.fn(async()=>{throw Error('Initial Main has no old source')})}})
  await resource.start();cleanups.push(()=>resource.stop())
  const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:resource.path}});cleanups.push(()=>rpc.dispose())
  const inspect=vi.fn((id:string)=>{expect(id).toBe(actual.record.agentSessionId);return f.h.client.inspectAgentCreation(id)})
  const forwarded:any[]=[]
  const owner=new AgentMuxRpcService({spatialState:spatial,coreClients:()=>[{hostId:foreign,client:{inspectAgentCreation:inspect,forwardRpc:async(method:any,params:any,context:any)=>{forwarded.push({method,params});return rpc.call(method,params,context)}} as never}]});cleanups.push(()=>owner.dispose())
  const input={target,creation:{hostId:'local',operationId:actual.record.requestId}},context={transport:'unix' as const,principal:{kind:'user' as const,id:'original-person'}}
  const value=await owner.call('space.mote.dialogue.setup.advance',input,context)
  expect(value).toMatchObject({creation:'confirmed',source:'not-needed',binding:'unconfirmed',bindingReceipt:{operationId:intent.bindOperationId,status:'unconfirmed'}})
  await owner.call('space.mote.dialogue.setup.advance',input,context);await owner.call('space.mote.dialogue.setup.inspect',input,context)
  expect(remoteSave).toHaveBeenCalledOnce();expect(remoteRead.mock.calls.length).toBeGreaterThan(0);expect(remoteSources.mock.calls.length).toBeGreaterThan(0)
  expect(forwarded.every(call=>call.params.target.expectedResource.hostId===foreign)).toBe(true)
  expect(f.save).not.toHaveBeenCalled();expect(f.link).not.toHaveBeenCalled();expect(f.h.started).toHaveLength(1);expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
})
it('unknown or refused native preference results never become a successful save when admission retention also fails',async()=>{
  for (const outcome of ['unknown','refused'] as const) {
    const f=await fixture(),admission=await originalAdmission(f),input=moteMainBindingInput(admission.record,admission.baseline)
    vi.spyOn(f.spatial,'recordMoteMainBindingResult').mockRejectedValue(Error('Original admission disk unavailable'))
    if (outcome==='unknown') vi.spyOn((f.quick as any).ports.files,'write').mockImplementationOnce(async (...args:any[])=>({resource:args[0].expectedResource,result:{status:'unknown',code:'WRITE_UNCONFIRMED',message:'Original File outcome unknown'}}))
    else await writeFile(f.path,(await readFile(f.path,'utf8'))+'\nLater original edit.\n')
    const result=await f.call('space.mote.preferences.save',input)
    expect(result.status).toBe(outcome==='unknown'?'unconfirmed':'refused-before-write');expect(result.message).toContain('admission retention is unconfirmed');expect(result.message).not.toContain('succeeded')
    expect(f.h.started).toHaveLength(1);expect(f.h.rawInput).not.toHaveBeenCalled();expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
  }
})
it('original source evidence after a later Main preserves only actual writer facts instead of inventing a complete preferences snapshot',async()=>{
  const f=await fixture(),admission=await originalAdmission(f),binding=moteMainBindingInput(admission.record,admission.baseline)
  const writerValues={...binding.values,presence:{enabled:true,intervalMs:3_600_000}}
  const saved=await f.call('space.mote.preferences.save',{...binding,values:writerValues})
  expect(saved.status).toBe('saved');expect(spatialAgentOpenRecord((await f.spatial.read())!.graph,admission.record.requestId)!.moteMainFollowUps?.bindingReceipt).toBeUndefined()
  // A later original writer changes the current Main; the earlier binding is only in its source journal.
  const read=await f.quick.read({kind:'quick',target:f.target}),baseline=moteQuickBaseline(read)!,{hostId:_,sessionId:__,...location}=f.old
  expect((await f.call('space.mote.preferences.save',{kind:'quick',target:f.target,operationId:'later-original-main',baseline,values:{...baseline.defaults,conversation:f.old},destination:{kind:'occurrence',...location}})).status).toBe('saved')
  const before=await readFile(f.spatial.path,'utf8'),observed=await f.call('space.mote.dialogue.setup.inspect',admission.input)
  expect(observed).toMatchObject({binding:'confirmed',bindingReceipt:null,bindingObserved:{kind:'source',operationId:binding.operationId,reference:binding.values.conversation,roleRevision:saved.source.defaults.conversationRevision,file:{resource:saved.source.resource,revision:saved.source.document.revision}}})
  expect(observed.bindingObserved).not.toHaveProperty('defaults');expect(observed.bindingObserved).not.toHaveProperty('source')
  expect(await readFile(f.spatial.path,'utf8')).toBe(before)
  const reconciled=await f.call('space.mote.dialogue.setup.advance',admission.input)
  expect(reconciled.record.moteMainFollowUps.bindingObserved).toEqual(observed.bindingObserved);expect(pendingMoteMainCreation((await f.spatial.read())!.graph,f.target)).toBeNull()
  const final=await f.quick.read({kind:'quick',target:f.target})
  expect(final.defaults).toMatchObject({conversation:f.old,presence:writerValues.presence});expect(f.save).toHaveBeenCalledTimes(2);expect(f.h.started).toHaveLength(1)
})
