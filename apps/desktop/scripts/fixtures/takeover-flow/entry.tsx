import { useState } from 'react'
import { createClientUiRoot } from '../../../test/helpers/client-ui-render'
import { prepareRendererUpdate, useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { SessionPane } from '../../../src/renderer/src/components/SessionPane'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import { WorkbenchPresentationContext } from '../../../src/renderer/src/lib/workbench-presentation'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph } from '../../../src/renderer/src/lib/desktop-spatial-state'
import { spatialCatalog } from '../../../src/renderer/src/lib/space-agent-control'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { createWorkspaceLayout } from '@agentmux/layout'
import { directoryIdentity, homeZoneId } from '../../../src/shared/space-addresses'
import { scratchTopicsScope } from '../../../src/renderer/src/lib/scratch-topic-snapshots'
import { mintObjectId } from '@agentmux/core/object-id'
import { DEFAULT_MOTE_FACE } from '../../../src/shared/mote-avatars'
import type { AgentMuxRpcParams, AgentMuxRpcResult } from '@agentmux/core'
import type { AgentTakeoverProvenance } from '@agentmux/core/agent-takeover'
import type { AppConfig, ScratchTopicSnapshot, SessionSnapshot } from '../../../src/shared/contracts'
import { fixturePath } from '../../lib/fixture-values.mjs'
import '../../../src/renderer/src/styles/index.css'

declare global {
  interface Window {
    takeoverFlowNative: {
      boot(): Promise<{ mode: 'first' | 'second'; topics: ScratchTopicSnapshot[] | null }>
      saveTopics(topics: ScratchTopicSnapshot[]): Promise<void>
      spatialRead(): ReturnType<typeof api.spatial.read>
      spatialCommit(input: Parameters<typeof api.spatial.commit>[0]): ReturnType<typeof api.spatial.commit>
      flush(): Promise<void>
    }
  }
}
const bridge = window.takeoverFlowNative, boot = await bridge.boot()

const runtimeId = 'private-flow-core', reference = { displayWorkspaceId: 'project', groupId: 'project-group', tabId: 'original-tab', regionId: 'original-region' }
const sourcePath = fixturePath('fixture/project'), scratchPath = fixturePath('fixture/clubs')
const scratch = { id: '__scratch__', hostId: 'local', name: 'Clubs', path: scratchPath, kind: 'folder' as const }
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: Object.fromEntries(['codex', 'claude', 'gemini'].map(providerId => [providerId, { label: providerId[0]!.toUpperCase() + providerId.slice(1), providerId, command: providerId, args: [], env: {}, injectAgentMuxGuide: false }])),
  workspaces: [{ id: 'project', hostId: 'local', name: 'Design workspace', path: sourcePath, kind: 'folder' }, scratch],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: {} }, promotion: { enabled: true } }
const original: Extract<SessionSnapshot, { kind: 'agent' }> = { id: 'original-agent', kind: 'agent', hostId: 'local', providerId: 'codex', executorId: 'codex', workspacePath: sourcePath,
  control: { kind: 'agent', hostId: 'local', agentSessionId: 'original-agent', run: { runId: 'original-run' } },
  label: 'Design research · system architecture', createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1, latestOutputBytes: 0,
  processState: 'running', promptSubmissionPredecessor: null, status: { state: 'running', source: 'run-process', observedAt: 1 },
  capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' } }
// This file contains only controlled content inputs, never a second spatial or admission store.
const topics: ScratchTopicSnapshot[] = boot.topics ?? ['Design Club', 'Build Club · tools and infrastructure'].map((title, index) => ({ id: mintObjectId(), title, summary: '', kind: 'mote',
  directoryPath: scratchPath + '/mote-' + index, physicalDirectoryPath: scratchPath + '/mote-' + index,
  identityDirectoryPath: scratchPath + '/mote-' + index, topicPath: scratchPath + '/mote-' + index + '/topic.md', collaborators: [],
  soul: { path: 'mote-' + index + '/SOUL.md', content: '# ' + title + '\n\nControlled private Mote content.\n', version: 'controlled-soul-v1' } }))
const tab = createWorkbenchTab(reference.tabId, { kind: 'agent', phase: 'attached', workspaceId: 'project', sessionId: original.id, regionId: reference.regionId })
const forbidden: string[] = [], calls: Array<{ method: string; input: unknown }> = [], nativeReads: Array<{ operation: string; runId: string }> = []
const sourceSpace = directoryIdentity('local', sourcePath)
const initial = { config, loading: false, sessions: [original], tabs: { [tab.id]: tab }, layouts: { project: createWorkspaceLayout(reference.groupId, [tab.id]) },
  activeWorkspaceId: 'project', mainSurface: 'workbench' as const, agentComposerDrafts: { [original.id]: 'Keep the unsent original design notes.' },
  spaceZoneBindings: Object.fromEntries(topics.map(topic => { const spaceId = directoryIdentity('local', topic.identityDirectoryPath!); return [homeZoneId(spaceId), { spaceId, workspaceId: scratch.id, directoryPath: topic.physicalDirectoryPath!, topicId: topic.id, contentKind: 'mote' as const }] })),
  scratchTopicSnapshots: { [scratch.id]: { scope: scratchTopicsScope(scratch), topics, revision: 1, reading: false, error: null } },
  spaceObjectIcons: { [directoryIdentity('local', topics[0]!.identityDirectoryPath!)]: { ...DEFAULT_MOTE_FACE, palette: 'rose' as const } },
  topicCategories: [], spatialRequests: {}, agentOperations: {}, error: null }
if (boot.mode === 'first') {
  if (await bridge.spatialRead()) throw Error('The private first process must arrange an empty original Core spatial owner.')
  const graph = desktopSpatialGraph({ ...useAppStore.getState(), ...initial }, topics)
  graph.regions.find(region => region.regionId === reference.regionId)!.execution = { hostId: 'local', runtimeId, cwd: sourcePath }
  await bridge.saveTopics(topics)
  await bridge.spatialCommit({ expectedRevision: 0, graph })
} else if (!boot.topics || !await bridge.spatialRead()) throw Error('The second Renderer needs the original content inputs and Core spatial file; it cannot reseed them.')
const owner = { runtimeId, ownerInstanceId: 'private-flow-instance', protocolVersion: 2 as const, availability: 'connected' as const, ctxmux: null, processId: 1 }
api.spatial.owner = async () => ({ owner })
api.config.get = async () => config
api.spatial.read = () => bridge.spatialRead()
api.spatial.commit = input => bridge.spatialCommit(input)
api.spatial.onChange = () => () => {}
api.ui.requestStorageFlush = () => bridge.flush()
api.scratch.listTopics = async workspaceId => workspaceId === scratch.id ? topics : []
api.scratch.readTopic = async (workspaceId, id) => workspaceId === scratch.id ? topics.find(topic => topic.id === id) ?? null : null
api.agentPromotions.call = async () => ({ promotion: null }) as never
api.sessions.snapshot = async () => ({ sessions: [original], timelines: { [original.id]: { agentSessionId: original.id, revision: 0, items: [] } }, recoveryCandidates: [] })
function controlledOriginal(control: Parameters<typeof api.sessions.refresh>[0], operation: string) {
  if (control.kind !== 'agent' || control.hostId !== original.hostId || control.agentSessionId !== original.control.agentSessionId || control.run.runId !== original.control.run.runId)
    throw Error('The controlled Native snapshot does not own this exact source Host, Session and Run.')
  nativeReads.push({ operation, runId: control.run.runId })
  return structuredClone(original)
}
api.sessions.refresh = async control => controlledOriginal(control, 'refresh')
// The controlled Native source already reports this running Run. The generic web-preview
// recovery owns different sessions and must not fabricate a replacement for this source.
api.sessions.recover = async control => ({ kind: 'reattachable', session: controlledOriginal(control, 'recover') })
api.sessions.historySources = async () => []
api.sessions.launchAgent = async () => { forbidden.push('renderer-creator'); throw Error('This visual scene has no native creation port') }
api.sessions.stop = async () => { forbidden.push('stop'); throw Error('This visual scene cannot stop an Agent') }
api.sessions.write = async () => { forbidden.push('input'); throw Error('This visual scene cannot send Agent input') }
const records = new Map<string, { input: AgentMuxRpcParams<'agent.open'>; report: AgentMuxRpcResult<'agent.open'> | null }>()
let held: { operationId: string; resolve(value: AgentMuxRpcResult<'agent.open'>): void; reject(error: Error): void } | null = null
const creations = new Map<string, ReturnType<typeof createdSession>>()
function createdSession(id: string, operationId: string) { return { ...original, id, control: { ...original.control, agentSessionId: id, run: { runId: 'receiver-run' } }, creation: { createOperationId: operationId } } }
function report(operationId: string, outcome: 'opened' | 'partial' | 'retired' | 'unknown'): AgentMuxRpcResult<'agent.open'> {
  const input = records.get(operationId)!.input, destination = input.destination
  const target = topics.find(topic => directoryIdentity('local', topic.identityDirectoryPath!) === destination.spaceId)!
  const sid = 'private-receiver', to = { spaceId: destination.spaceId!, zoneId: destination.zoneId!, workspaceId: target ? scratch.id : 'project',
    displayWorkspaceId: destination.displayWorkspaceId!, groupId: destination.groupId!, tabId: 'receiver-tab', regionId: 'receiver-region' }
  const takeover: AgentTakeoverProvenance = { source: { hostId: 'local', runtimeId, agentSessionId: original.id, run: original.control.run,
    organization: { reference: { runtimeId, spaceId: sourceSpace }, kind: 'project', organizationId: sourceSpace, title: 'Design project' } },
    destination: { owner: { runtimeId }, address: to, organization: target ? { reference: { runtimeId, spaceId: to.spaceId }, kind: 'mote', organizationId: target.id, title: target.title }
      : { reference: { runtimeId, spaceId: sourceSpace }, kind: 'project', organizationId: sourceSpace, title: 'Design project' } }, nature: target ? 'promotion' : 'takeover' }
  const value = { operation: 'agent.open' as const, operationId, outcome, from: null, to, resource: null,
    agent: outcome === 'unknown' ? null : { agentSessionId: sid, hostId: 'local', runId: outcome === 'retired' ? null : 'receiver-run', executorId: 'codex', providerId: 'codex', cwd: target?.physicalDirectoryPath ?? sourcePath,
      createOperationId: operationId, initialPrompt: 'confirmed' as const, takeover },
    save: { layoutApplied: true, clientStateWritten: true, storageFlushRequested: true, diskDurability: 'confirmed' as const },
    issues: outcome === 'unknown' ? [{ step: 'observation', code: 'PRIVATE_VISUAL_UNCONFIRMED', message: 'The original creation result is unconfirmed. This same request is retained.', recovery: 'Inspect the original operation.' }] : [] }
  return value as never
}
api.spatial.openAgent = async input => { calls.push({ method: 'agent.open', input: structuredClone(input) }); records.set(input.operationId, { input: structuredClone(input), report: null });
  return await new Promise((resolve, reject) => { held = { operationId: input.operationId, resolve, reject } }) }
api.spatial.inspectOperation = async input => {
  calls.push({ method: 'space.inspect', input: structuredClone(input) })
  const id = 'operationId' in input.target ? input.target.operationId : '', original = records.get(id)
  return { operation: 'space.inspect', request: original ? { operationId: id, report: original.report } : null } as never
}
api.sessions.creation = async (_host, id) => { const session = creations.get(id); if (!session) throw Error('No controlled visual creation was recorded'); return { kind: 'agent', hostId: 'local', agentSessionId: id, providerId: 'codex', executorId: 'codex', workspacePath: sourcePath,
  createdAt: session.createdAt, updatedAt: session.updatedAt, run: session.control.run, retiredRuns: [], creation: session.creation } }
await useAppStore.getState().initialize()
await useAppStore.getState().selectWorkspace('project')
if (boot.mode === 'first') {
  useAppStore.setState({ agentComposerDrafts: initial.agentComposerDrafts, spaceObjectIcons: initial.spaceObjectIcons,
    activeWorkspaceId: initial.activeWorkspaceId, mainSurface: initial.mainSurface })
}
await useAppStore.getState().refreshScratchTopics(scratch.id, true)
useAppStore.setState({ detectExecutors: async () => {}, refreshSpatialState: async () => {}, renameAgent: async () => true })
mountThemeRuntime(window, config.appearance)
function Scene() {
  const [settings, setSettings] = useState(false)
  return <main style={{ height: '100vh', padding: '32px clamp(18px, 5vw, 64px)', display: 'flex', flexDirection: 'column', gap: 14, background: 'var(--surface-0)', color: 'var(--text)' }}>
    <header style={{ fontSize: 12, color: 'var(--text-3)' }}>Design workspace <span style={{ opacity: .45 }}> / </span> original work</header>
    <section style={{ flex: 1, minHeight: 0, position: 'relative', border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden', background: 'var(--surface-1)' }}>
      <WorkbenchPresentationContext.Provider value={{ active: true, retainedRegionId: null, reference }}>
        <SessionPane sessionId={original.id} surfaceKind="agent" visible parked interactiveResize={false}
          linkOrigin={{ workspaceId: 'project', tabGroupId: reference.groupId, tabId: reference.tabId, regionId: reference.regionId }} />
      </WorkbenchPresentationContext.Provider>
    </section>
    <footer style={{ display: 'flex', gap: 16, alignItems: 'center', fontSize: 12, color: 'var(--text-3)' }}><span>Original Session and draft stay here.</span><button className="small-button" onClick={() => setSettings(true)}>Promotion settings</button></footer>
    {settings ? <SettingsPanel initialSection="mote-promotion" onClose={() => setSettings(false)} /> : null}
  </main>
}
createClientUiRoot(document.getElementById('root')!).render(<Scene />)
Object.assign(window, { takeoverFlowProbe: { ready: true,
  checkpoint() { return prepareRendererUpdate() },
  theme(light: boolean) { const appearance = { ...config.appearance, appAppearance: light ? 'light' as const : 'dark' as const }; updateThemeSelection(appearance, window); useAppStore.setState(state => ({ config: { ...state.config!, appearance } })) },
  unknown() { if (!held) throw Error('No original request'); const { operationId, reject } = held; records.get(operationId)!.report = report(operationId, 'unknown'); held = null; reject(Error('The original reply was lost. The exact operation is kept.')) },
  retired() { if (!held) throw Error('No original request'); const { operationId, resolve } = held; const value = report(operationId, 'retired'); records.get(operationId)!.report = value; held = null; resolve(value) },
  facts() { const state = useAppStore.getState(); return { processMode: boot.mode, noWorkfaceReseed: boot.mode === 'second', sessions: state.sessions,
    source: state.tabs[reference.tabId], layouts: state.layouts, draft: state.agentComposerDrafts[original.id], forbidden, calls, nativeReads, operations: state.agentOperations,
    catalog: spatialCatalog(state, Object.values(state.scratchTopicSnapshots).flatMap(value => value.topics ?? [])) } }
} })
