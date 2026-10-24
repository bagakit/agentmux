import { createElement } from 'react'
import { DEFAULT_MOTE_FACE } from '../../../src/shared/mote-avatars'
import { topicSpaceIconTarget } from '../../../src/renderer/src/lib/space-object-appearance'
import { createClientUiRoot } from '../../../test/helpers/client-ui-render'
import { createWorkspaceLayout } from '@agentmux/layout'
import { conversationRevision, parseConversationReadPage, projectConversationTimeline, type ConversationTimelineReadInput } from '@agentmux/core/conversation'
import { parseMessageEventsPage } from '../../../../../packages/core/src/agent-message-events'
import type { AgentMuxAgentSession, AgentSessionHistoryDescriptor, AgentMuxMessageEvent, AgentMuxSpawnRecord, AgentTimelineSnapshot } from '@agentmux/core'
import type { RuntimeEvent, SessionSnapshot, SessionHistorySourcesObservation, ScratchTopicSnapshot, WorkspaceRecord } from '../../../src/shared/contracts'
import { SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../../../src/shared/scratch-topics'
import { directoryIdentity, homeZoneId, workspaceZoneId } from '../../../src/shared/space-addresses'
import { App } from '../../../src/renderer/src/App'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph } from '../../../src/renderer/src/lib/desktop-spatial-state'
import { fixturePath } from '../../lib/fixture-values.mjs'
import type { CollaborationLayoutBox, CollaborationLayoutRequest, CollaborationLayoutResponse } from '../../../src/renderer/src/lib/collaboration-layout-engine'
import { COLLABORATION_ACTIVITY_MS } from '../../../src/renderer/src/lib/collaboration-map-presentation'
import { collaborationAreaNode, collaborationAgentNode } from '../../../src/renderer/src/lib/collaboration-presentation'
import { createAdaptivePresentationObserver } from './adaptive-observer'
import '../../../src/renderer/src/styles/index.css'

// Finite fixture diagnostics only. Read native entry payloads, never layout or
// styles; invoke the original callback immediately and preserve error delivery.
let diagnosticPhase = 'load-original-app', resizeObserverSequence = 0, resizeObservationMS = 0, resizeCallbackBatches = 0
type ResizeBatch = { observer: number; phase: string; at: number; entries: number; targets: Array<{ tag: string; class: string | null; nodeId: string | null; regionId: string | null; width: number; height: number }> }
const resizeBatches: ResizeBatch[] = [], resizeConstructors: Array<{ observer: number; at: number; stack?: string }> = []
const rendererDiagnostics: Array<{ kind: string; phase: string; at: number; wallTime: string; message: string; stack?: string; filename?: string; line?: number; column?: number; recentResizeBatches: readonly ResizeBatch[] }> = []
const OriginalResizeObserver = window.ResizeObserver
window.ResizeObserver = class extends OriginalResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    const start = performance.now(), observer = ++resizeObserverSequence
    if (resizeConstructors.length < 256) resizeConstructors.push({ observer, at: start, stack: new Error('Native ResizeObserver construction').stack?.slice(0, 4000) })
    super((entries, instance) => {
      const start = performance.now()
      resizeCallbackBatches++
      resizeBatches.push({ observer, phase: diagnosticPhase, at: start, entries: entries.length, targets: entries.slice(0, 32).map(entry => ({
        tag: entry.target.tagName, class: entry.target.getAttribute('class')?.slice(0, 240) ?? null,
        nodeId: entry.target.getAttribute('data-id')?.slice(0, 240) ?? null, regionId: entry.target.getAttribute('data-region-id')?.slice(0, 240) ?? null,
        width: entry.contentRect.width, height: entry.contentRect.height })) })
      if (resizeBatches.length > 16) resizeBatches.shift()
      resizeObservationMS += performance.now() - start
      callback.call(instance, entries, instance)
    })
    resizeObservationMS += performance.now() - start
  }
}
window.addEventListener('error', event => {
  rendererDiagnostics.push({ kind: 'error', phase: diagnosticPhase, at: performance.now(), wallTime: new Date().toISOString(), message: event.message,
    stack: event.error instanceof Error ? event.error.stack : undefined, filename: event.filename, line: event.lineno, column: event.colno, recentResizeBatches: [...resizeBatches] })
})
window.addEventListener('unhandledrejection', event => {
  rendererDiagnostics.push({ kind: 'unhandledrejection', phase: diagnosticPhase, at: performance.now(), wallTime: new Date().toISOString(), message: String(event.reason),
    stack: event.reason instanceof Error ? event.reason.stack : undefined, recentResizeBatches: [...resizeBatches] })
})

// Transparent instrumentation: actual browser Workers and original context code execute.
const nativeWorkers: Array<{ request?: { type: CollaborationLayoutRequest['type']; id: string; queuedAt: number; sentAt?: number; delayMS: number; connectionIds: string[]; anchor?: string | null }; errors?: Array<Extract<CollaborationLayoutResponse, { type: 'error' }> & { at: number }>; retainedPathIds?: string[]; input?: { nodes: number; connections: number; ids: string[]; sizes: Record<string, number>; areas: Array<{ id: string; members: number; parentId?: string | null }>; edges: Array<{ id: string; source: string; target: string; kind: string; strength?: number }> }; boxes?: { agents: number; ids: string[]; areas: Array<{ id: string; width: number; height: number }> }; geometry?: readonly CollaborationLayoutBox[]; pathIds?: string[]; responses?: Array<{ type: CollaborationLayoutResponse['type']; at: number }>; complete?: boolean; terminated?: boolean; observerMS: number }> = []
let delayedRoute: { milliseconds: number; sender: string; recipient: string } | undefined
const OriginalWorker = window.Worker
class ObservedWorker extends OriginalWorker {
  private readonly sample: typeof nativeWorkers[number] = { observerMS: 0 }
  private delayed?: ReturnType<typeof setTimeout>
  constructor(...args: ConstructorParameters<typeof OriginalWorker>) {
    super(...args); nativeWorkers.push(this.sample)
    this.addEventListener('message', (event: MessageEvent<CollaborationLayoutResponse>) => {
      const start = performance.now()
      ;(this.sample.responses ??= []).push({ type: event.data.type, at: start })
      if (event.data?.type === 'boxes' && Array.isArray(event.data.boxes)) this.sample.boxes = { agents: event.data.boxes.filter(box => box.kind === 'agent').length, ids: event.data.boxes.filter(box => box.kind === 'agent').map(box => box.id), areas: event.data.boxes.filter(box => box.kind === 'area').map(({ id, width, height }) => ({ id, width, height })) }
      if (event.data?.type === 'boxes' && Array.isArray(event.data.boxes)) { this.sample.geometry = event.data.boxes; this.sample.retainedPathIds = [...event.data.retainedPaths ?? []] }
      if (event.data?.type === 'error') (this.sample.errors ??= []).push({ ...event.data, at: start })
      if (event.data?.type === 'complete') this.sample.complete = true
      if (event.data?.type === 'paths') this.sample.pathIds = [...this.sample.pathIds ?? [], ...Object.keys(event.data.paths)]
      this.sample.observerMS += performance.now() - start
    })
  }
  override postMessage(message: unknown, transfer: Transferable[]): void
  override postMessage(message: unknown, options?: StructuredSerializeOptions): void
  override postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions): void {
    const start = performance.now(), request = message as CollaborationLayoutRequest
    if ((request?.type === 'arrange' || request?.type === 'reconcile') && Array.isArray(request.input?.nodes) && Array.isArray(request.input?.connections)) {
      const sizes: Record<string, number> = {}
      for (const node of request.input.nodes) { const size = `${node.width}x${node.height}`; sizes[size] = (sizes[size] ?? 0) + 1 }
      this.sample.input = { nodes: request.input.nodes.length, connections: request.input.connections.length, ids: request.input.nodes.map(node => node.id), sizes, areas: request.input.areas.map(area => ({ id: area.id, members: area.members.length, parentId: area.parentId })), edges: request.input.connections.map(({ id, source, target, kind, strength }) => ({ id, source, target, kind, strength })) }
    }
    const subject = (id: string) => JSON.parse(id)[1] as string
    const delayMS = request?.type === 'route' && delayedRoute && request.connections.some(connection => connection.kind === 'communication' &&
      subject(connection.source) === JSON.stringify(['local', delayedRoute!.sender]) && subject(connection.target) === JSON.stringify(['local', delayedRoute!.recipient])) ? delayedRoute.milliseconds : 0
    if (request && ['arrange', 'reconcile', 'route'].includes(request.type)) this.sample.request = { type: request.type, id: request.id, queuedAt: performance.now(), delayMS, connectionIds: (request.type === 'route' ? request.connections : request.input.connections).map(connection => connection.id), ...(request.type === 'reconcile' ? { anchor: request.anchor } : {}) }
    this.sample.observerMS += performance.now() - start
    const send = () => { if (this.sample.request) this.sample.request.sentAt = performance.now(); if (Array.isArray(options)) super.postMessage(message, options); else super.postMessage(message, options) }
    // A finite transport delay preserves the original request, Worker and routing result.
    if (delayMS) this.delayed = setTimeout(send, delayMS)
    else send()
  }
  override terminate() { clearTimeout(this.delayed); this.sample.terminated = true; super.terminate() }
}
window.Worker = ObservedWorker
const instrumentation = () => (globalThis as typeof globalThis & { __collaborationCaptureMetrics?: { contextCalls: number; contextIds: Record<string, number>; contextCounterMS: number } }).__collaborationCaptureMetrics ?? { contextCalls: 0, contextIds: {}, contextCounterMS: 0 }
let measurement: { label: string; start: number; frames: number[]; longTasks: Array<{ start: number; duration: number }>; observer?: PerformanceObserver; frame: number; previous: number; before: ReturnType<typeof counters>; overheadMS: number } | undefined
function census() {
  const start = performance.now(), map = document.querySelector('.collaboration-map'), canvas = map?.querySelector('.collaboration-canvas'), bounds = canvas?.getBoundingClientRect()
  const nodes = [...map?.querySelectorAll<HTMLElement>('[data-collaboration-agent]') ?? []]
  return { nodes: nodes.length, fullCards: map?.querySelectorAll('.focus-context[data-session-id]').length ?? 0, marks: map?.querySelectorAll('.collaboration-agent__mark').length ?? 0,
    onscreen: nodes.filter(node => { const rect = node.getBoundingClientRect(); return bounds && rect.right > bounds.left && rect.left < bounds.right && rect.bottom > bounds.top && rect.top < bounds.bottom }).length,
    matrix: map?.querySelector('.react-flow__viewport')?.getAttribute('style'), samplingMS: performance.now() - start }
}
function counters() { const counts = instrumentation(); return { contextCounterMS: counts.contextCounterMS, workerObserverMS: nativeWorkers.reduce((total, sample) => total + sample.observerMS, 0), contextCalls: counts.contextCalls, contextIds: { ...counts.contextIds }, events: reads.filter(read => read.kind === 'events').length, bodies: reads.filter(read => read.kind === 'body').length, workers: nativeWorkers.length } }
function beginMeasurement(label: string) {
  if (measurement) throw Error('One finite measurement at a time')
  const sample = measurement = { label, start: performance.now(), frames: [], longTasks: [], frame: 0, previous: 0, before: counters(), overheadMS: 0 } as NonNullable<typeof measurement>
  const loop = (at: number) => { if (measurement !== sample) return; const start = performance.now(); if (sample.previous) sample.frames.push(at - sample.previous); sample.previous = at; sample.frame = requestAnimationFrame(loop); sample.overheadMS += performance.now() - start }
  sample.frame = requestAnimationFrame(loop)
  if (PerformanceObserver.supportedEntryTypes.includes('longtask')) { sample.observer = new PerformanceObserver(list => { const start = performance.now(); for (const entry of list.getEntries()) sample.longTasks.push({ start: entry.startTime, duration: entry.duration }); sample.overheadMS += performance.now() - start }); sample.observer.observe({ type: 'longtask', buffered: false }) }
}
function endMeasurement() {
  if (!measurement) throw Error('No native measurement is active')
  const sample = measurement; measurement = undefined; cancelAnimationFrame(sample.frame)
  for (const entry of sample.observer?.takeRecords() ?? []) sample.longTasks.push({ start: entry.startTime, duration: entry.duration })
  sample.observer?.disconnect()
  const after = counters(), gaps = [...sample.frames].sort((a, b) => a - b), dom = census()
  return { label: sample.label, elapsedMS: performance.now() - sample.start, frameCount: gaps.length, tailFrameGapMS: sample.previous ? performance.now() - sample.previous : null, frameGapMS: { max: Math.max(0, ...gaps), p95: gaps[Math.floor(gaps.length * .95)] ?? null, over50: gaps.filter(gap => gap > 50).length }, longTaskSupported: PerformanceObserver.supportedEntryTypes.includes('longtask'), longTasks: sample.longTasks,
    observerOverheadMS: sample.overheadMS, contextCounterOverheadMS: after.contextCounterMS - sample.before.contextCounterMS, workerObserverOverheadMS: after.workerObserverMS - sample.before.workerObserverMS, boundaryCensusMS: dom.samplingMS, before: sample.before, after, contextDelta: after.contextCalls - sample.before.contextCalls,
    builtContextIds: Object.keys(after.contextIds).filter(id => after.contextIds[id]! > (sample.before.contextIds[id] ?? 0)), eventReadsDelta: after.events - sample.before.events, dom }
}

// All controlled values enter at the platform boundary. Product Store actions,
// App initialization, Graph, card intent and the sole Reader host stay original.
// Forward public requests to the exact callback admitted by original App initialization.
const originalControlRegistration = api.control.onRequest.bind(api.control)
let admittedControl: Parameters<typeof api.control.onRequest>[0] | undefined
const publicRequests: Array<{ id: string; operation: string }> = [], publicSignals = new Map<string, AbortController>()
api.control.onRequest = listener => {
  admittedControl = listener
  const dispose = originalControlRegistration(listener)
  return () => { if (admittedControl === listener) admittedControl = undefined; dispose() }
}
const originalConfig = await api.config.get(), originalSnapshot = await api.sessions.snapshot()
const base = originalSnapshot.sessions.find((session): session is Extract<SessionSnapshot, { kind: 'agent' }> => session.kind === 'agent')
if (!base || !originalConfig.workspaces[0]) throw Error('Nonempty typed platform samples required')
const scenario = new URLSearchParams(location.search).get('scenario')
const perception = scenario === 'perception' || scenario === 'perception-scale'
const now = Date.now(), hostId = 'local', incarnation = 'fixture-collaboration-journal'
const projects: WorkspaceRecord[] = [
  { ...originalConfig.workspaces[0], id: 'fixture-protocol', hostId, name: perception ? 'AgentMux · 多 Agent 协作与持久会话' : 'Agent protocol', path: fixturePath('private/graph/protocol'), repoPath: fixturePath('private/graph/protocol'), kind: 'folder' as const },
  { ...originalConfig.workspaces[0], id: 'fixture-worktree', hostId, name: 'Delivery worktree', path: fixturePath('private/graph/protocol/.worktrees/delivery'), repoPath: fixturePath('private/graph/protocol'), kind: 'worktree' as const },
  { ...originalConfig.workspaces[0], id: SCRATCH_WORKSPACE_ID, hostId, name: 'Topics', path: fixturePath('private/graph/topics'), kind: 'folder' as const }
]
const scratch = projects[2]!
const background = Array.from({ length: 8 }, (_, index): WorkspaceRecord => ({ id: 'fixture-background-' + index, hostId, name: perception ? ['FlowLens 数据工作台', 'Pageville', '工作流与工具', 'Cloudflare 域名与邮件', '个人知识库', 'Farm', '设计素材', '研究记录'][index]! : 'Independent work ' + (index + 1), path: fixturePath('private/graph/independent/' + index), kind: 'folder' }))
const emptyProjects = Array.from({ length: scenario === 'endpoints' ? 0 : scenario === 'perception' ? 6 : 60 }, (_, index): WorkspaceRecord => ({ id: 'fixture-empty-' + index, hostId, name: index % 3 ? 'Unassigned project ' + (index + 1) : '归档与材料 ' + (index + 1), path: fixturePath('private/graph/empty/' + index), kind: 'folder' }))
const singletonProjects = Array.from({ length: scenario === 'endpoints' ? 0 : 12 }, (_, index): WorkspaceRecord => ({ id: 'fixture-singleton-' + index, hostId, name: 'Independent contributor ' + (index + 1), path: fixturePath('private/graph/singleton/' + index), kind: 'folder' }))
if (perception) Object.assign(emptyProjects[0]!, { hostId: 'fixture-remote', name: 'Remote · 模型评测服务' })
const terrainProjects: WorkspaceRecord[] = scenario === 'perception-scale' ? [
  { id: 'fixture-terrain-root', hostId, name: '协作地形', path: projects[0]!.path + '/terrain', kind: 'folder' },
  { id: 'fixture-terrain-tools', hostId, name: '消息工具', path: projects[0]!.path + '/terrain/tools', kind: 'folder' },
  { id: 'fixture-terrain-deep', hostId, name: '渲染与交互', path: projects[0]!.path + '/terrain/tools/rendering', kind: 'folder' }
] : []
projects.push(...background, ...singletonProjects, ...emptyProjects, ...terrainProjects)
const category = { categoryId: '11111111-1111-4111-8111-111111111111', hostId,
  spaceId: directoryIdentity(hostId, fixturePath('private/graph/categories/quality')), directoryPath: fixturePath('private/graph/categories/quality'), title: 'Product quality', revision: null }
const topics: ScratchTopicSnapshot[] = [
  { id: 'view:graph-review', title: perception ? '消息协议与可观测性' : 'Read model notes', kind: 'topic', physicalDirectoryPath: fixturePath('private/graph/objects/read-model') },
  { id: 'view:graph-design', title: perception ? '产品设计师' : 'Interaction design', kind: 'mote', physicalDirectoryPath: fixturePath('private/graph/objects/interaction') }
].map(value => { const directoryPath = scratchTopicDirectoryName(value.id)
  return { ...value, directoryPath, identityDirectoryPath: scratch.path + '/' + directoryPath,
    confirmedDirectoryPaths: [scratch.path + '/' + directoryPath, value.physicalDirectoryPath], topicPath: directoryPath + '/topic.md', summary: '', collaborators: [],
    ...(value.kind === 'mote' ? { soul: { path: directoryPath + '/SOUL.md', content: 'Keep original interaction sources available.', version: 'fixture-soul' } } : {}) } as ScratchTopicSnapshot
})
const address = (topic: ScratchTopicSnapshot) => { const spaceId = directoryIdentity(hostId, topic.identityDirectoryPath!); return { spaceId, zoneId: homeZoneId(spaceId) } }
const moteAddress = address(topics[1]!), topicAddress = address(topics[0]!)
const projectSpace = directoryIdentity(hostId, projects[0]!.path), worktreeZone = workspaceZoneId(projectSpace, projects[1]!.id)
const bindings = { ...Object.fromEntries(topics.map(topic => [address(topic).zoneId, { spaceId: address(topic).spaceId, workspaceId: scratch.id,
  topicId: topic.id, contentKind: topic.kind, directoryPath: topic.physicalDirectoryPath,
  ...(topic.kind === 'topic' ? { relations: { [category.spaceId]: true } } : {}) }])),
  [worktreeZone]: { spaceId: projectSpace, workspaceId: projects[1]!.id, relations: { [moteAddress.spaceId]: true } } }
const identities = [
  ['fixture-ui', 'Conversation renderer', 'codex', 0], ['fixture-core', 'A2A delivery', 'claude', 0],
  ['fixture-review', 'Read model review', 'gemini', 1], ['fixture-design', 'Interaction design', 'codex', 1]
] as const
const { pendingInteraction: _pending, currentActivity: _activity, semanticStatus: _semantic, runUnobserved: _unobserved, ...plainBase } = base
let sessions: SessionSnapshot[] = identities.map(([id, label, providerId], index) => ({ ...plainBase,
  id, label, providerId, executorId: providerId, hostId, workspacePath: index < 2 ? projects[index]!.path : topics[index - 2]!.physicalDirectoryPath!,
  processState: 'running', status: { state: index === 2 ? 'done' : 'working', source: 'native-hook', observedAt: now },
  nativeSessionId: 'native-' + id, nativeHandle: { kind: 'provider', providerId, sessionId: 'native-' + id },
  semanticStatus: { state: index === 2 ? 'done' : 'working', source: 'native-hook', observedAt: now, stateEnteredAt: now - 30000, currentActivityRevision: 1 },
  currentActivity: { state: index === 2 ? 'idle' : 'active', source: 'native-hook', run: { runId: 'fixture-run-' + id }, nativeSessionId: 'native-' + id, nativeTurnId: 'turn-' + id, sourceId: 'source-' + id, sequence: 1, hookReceiptId: 'receipt-' + id, observedAt: now },
  control: { ...base.control, hostId, agentSessionId: id, run: { runId: 'fixture-run-' + id } }
}))
const originalSessions = sessions
const extraSessions: Array<Extract<SessionSnapshot, { kind: 'agent' }>> = Array.from({ length: 472 }, (_, index) => {
  const id = 'fixture-isolated-' + String(index).padStart(3, '0'), activity = index % 4, run = { runId: 'fixture-run-' + id }
  const slot = (index - singletonProjects.length) % 24
  const workspace = index < singletonProjects.length ? singletonProjects[index]! : slot < 8 ? projects[0]! : background[Math.floor((slot - 8) / 2)]!
  const native = { source: 'native-hook' as const, run, nativeSessionId: 'native-' + id, nativeTurnId: 'turn-' + id, sourceId: 'source-' + id, sequence: 1, hookReceiptId: 'receipt-' + id, observedAt: now }
  return { ...plainBase, id, label: ['Investigating source', 'Waiting for next task', 'Retained result', 'Activity unconfirmed'][activity] + ' ' + String(index).padStart(3, '0'), providerId: 'codex', executorId: 'codex', hostId,
    workspacePath: workspace.path, createdAt: now - (index + 1) * 1000, updatedAt: now, agentSessionUpdatedAt: now,
    control: { kind: 'agent', hostId, agentSessionId: id, run }, nativeSessionId: native.nativeSessionId, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: native.nativeSessionId },
    processState: activity === 2 ? 'exited' : 'running', status: { state: activity === 0 ? 'working' : activity === 2 ? 'done' : 'running', source: 'native-hook', observedAt: now },
    ...(activity !== 3 ? { semanticStatus: { state: activity === 0 ? 'working' as const : 'done' as const, source: 'native-hook' as const, observedAt: now, stateEnteredAt: now - (index + 1) * 3600000, currentActivityRevision: 1 } } : {}),
    ...(activity !== 2 ? { currentActivity: { ...native, state: activity === 0 ? 'active' as const : activity === 1 ? 'idle' as const : 'unknown' as const } } : {}) }
})
// Keep the four original workfaces separate from a realistic, uneven map catalog.
// Empty Projects never acquire members during the later 240/480 growth scenes.
const terrainSessions = terrainProjects.length ? ['fixture-terrain-tool', 'fixture-terrain-a', 'fixture-terrain-b'].map((id, index) => {
  const original = extraSessions[index * 4]!, run = { runId: 'fixture-run-' + id }, nativeSessionId = 'native-' + id
  return { ...original, id, label: ['消息路由', 'LOD 绘制', '交互评审'][index]!, workspacePath: terrainProjects[index === 0 ? 1 : 2]!.path,
    control: { ...original.control, agentSessionId: id, run }, nativeSessionId,
    nativeHandle: { kind: 'provider' as const, providerId: original.providerId, sessionId: nativeSessionId },
    currentActivity: { ...original.currentActivity!, run, nativeSessionId, nativeTurnId: 'turn-' + id, sourceId: 'source-' + id, hookReceiptId: 'receipt-' + id } }
}) : []
const initialSessions = [...originalSessions, ...terrainSessions, ...extraSessions.slice(0, scenario === 'endpoints' ? 4 : 88)]
sessions = initialSessions
const retired: AgentSessionHistoryDescriptor[] = Array.from({ length: scenario === 'endpoints' ? 0 : 4 }, (_, index) => ({ agentSessionId: 'fixture-retired-' + index, hostId, state: 'retired', retiredAt: now - (index + 1) * 86400000, history: { providerId: 'codex', executorId: 'codex', workspacePath: projects[0]!.path, createdAt: now - (index + 3) * 86400000 } }))
if (scenario === 'endpoints') retired.push({ agentSessionId: 'fixture-endpoint-retired', hostId, state: 'retired', retiredAt: now - 10000 })
const timelines: Record<string, AgentTimelineSnapshot> = Object.fromEntries(identities.map(([id, label]) => {
  const items: AgentTimelineSnapshot['items'] = [
    { id: id + '-input', agentSessionId: id, kind: 'user_message', source: 'user', status: 'complete', title: 'User message', content: 'Keep the original Session and inspect its recorded relationships.', authorHuman: true, createdAt: now - 40000, updatedAt: now - 40000 },
    { id: id + '-reply', agentSessionId: id, kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Reply', content: `${label}: the original owner and message identities are preserved. The next step is a bounded read of the recorded evidence.`, createdAt: now - 10000, updatedAt: now - 10000 }
  ]
  return [id, { agentSessionId: id, sourceHostId: hostId, revision: 2, items,
    stream: { epoch: 'fixture-stream-' + id, revision: 2, sequence: 2, origin: 'beginning', gaps: [],
      positions: items.map((item, at) => ({ id: item.id, firstSequence: at + 1, sequence: at + 1, revision: conversationRevision(item) })) } }]
}))
const config = { ...originalConfig, hosts: [...originalConfig.hosts.filter(host => host.id === hostId), ...(perception ? [{ id: 'fixture-remote', label: 'Research Lab', kind: 'ssh' as const, hostname: 'capture.invalid' }] : [])], workspaces: projects,
  appearance: { ...originalConfig.appearance, appAppearance: 'dark' as const }, focus: { recentActivityHours: 48 as const, ...originalConfig.focus, previewTrigger: 'quick' as const } }
const tabs = Object.fromEntries(originalSessions.map((session, at) => {
  const workspace = projects[at < 2 ? at : 2]!, topic = at < 2 ? undefined : topics[at - 2]
  const tab = { ...createWorkbenchTab('tab-' + session.id, { regionId: 'region-' + session.id, workspaceId: workspace.id, kind: 'agent', phase: 'attached', sessionId: session.id }, session.label),
    ...(topic ? { topicId: topic.id, space: { ...address(topic), spaceId: topic.kind === 'topic' ? category.spaceId : address(topic).spaceId } } : {}) }
  return [tab.id, tab] }))
const layouts = Object.fromEntries(projects.map((project, area) => [project.id, createWorkspaceLayout('group-' + area, originalSessions.filter((_, at) => area === 2 ? at >= 2 : area < 2 && at === area).map(session => 'tab-' + session.id))]))
// Feed the original spatial API before App's real initialize reads it. Execution
// Host/cwd live in its region facts, rather than in a mocked resolver or action.
const initialSpatial = await api.spatial.read()
await api.spatial.commit({ expectedRevision: initialSpatial?.revision ?? 0,
  graph: desktopSpatialGraph({ ...useAppStore.getState(), config, sessions, tabs, layouts, spaceZoneBindings: bindings, topicCategories: [category] }, topics) })
// Use the original preview ConfigOwner, including optimistic edit and change
// publication. Map and Settings save through the same original consumer boundary.
await api.config.save(config, originalConfig)
api.sessions.snapshot = async () => { reads.push({ kind: 'snapshot' }); return { sessions: structuredClone(sessions), timelines: structuredClone(timelines), recoveryCandidates: [] } }
api.sessions.timeline = async control => structuredClone(originalTimeline(control.agentSessionId))
const relationOnly: AgentSessionHistoryDescriptor = { agentSessionId: 'fixture-relationship-only', hostId, state: 'retired', retiredAt: now - 86400000,
  history: { providerId: 'claude', executorId: 'claude', workspacePath: projects[0]!.path, createdAt: now - 2 * 86400000 } }
function fixtureHistorySources(): Promise<AgentSessionHistoryDescriptor[]>
function fixtureHistorySources(options: { observation: true }): Promise<SessionHistorySourcesObservation>
async function fixtureHistorySources(options?: { observation: true }): Promise<AgentSessionHistoryDescriptor[] | SessionHistorySourcesObservation> {
  reads.push({ kind: 'history-sources' })
  const sources = [...sessions.filter(session => session.kind === 'agent').map(session => ({ hostId: session.control.hostId, agentSessionId: session.control.agentSessionId, state: 'active' as const })), ...structuredClone(retired)]
  return options?.observation ? { sources, warnings: [] } : sources
}
api.sessions.historySources = fixtureHistorySources
api.sessions.historySource = async reference => {
  reads.push({ kind: 'identity', participant: reference.agentSessionId, options: structuredClone(reference) })
  if (!('hostId' in reference) || reference.hostId !== hostId) return { reference, source: null,
    issue: { code: 'RUNTIME_UNAVAILABLE', message: 'This exact owner is outside the declared private scene.', recovery: 'Retain the original reference; no local identity is substituted.' } }
  const source = 'hostId' in reference && reference.hostId === hostId ? [...retired, relationOnly].find(source => source.agentSessionId === reference.agentSessionId)
    ?? (sessions.some(session => session.kind === 'agent' && session.control.agentSessionId === reference.agentSessionId) ? { hostId, agentSessionId: reference.agentSessionId, state: 'active' as const } : null) : null
  return { reference, source: structuredClone(source), issue: null }
}
api.scratch.listTopics = async () => structuredClone(topics)
api.workspaces.listBranches = async id => ({ kind: 'not-a-git-repository', hostId, workspacePath: projects.find(project => project.id === id)?.path ?? projects[0]!.path })
const listeners = new Set<(event: RuntimeEvent) => void>()
api.sessions.onEvent = listener => { listeners.add(listener); return () => { listeners.delete(listener) } }
const reads: Array<{ kind: string; participant?: string; options?: unknown }> = [], controls: string[] = []
for (const name of ['launchAgent', 'stop', 'resume', 'write', 'interrupt', 'submitPrompt'] as const) {
  const original = api.sessions[name]
  Object.assign(api.sessions, { [name]: (...args: never[]) => { controls.push(name); return (original as (...args: never[]) => unknown)(...args) } })
}
function originalTimeline(id: string): AgentTimelineSnapshot {
  const value = timelines[id]
  if (value) return value
  if (!sessions.some(session => session.id === id) && !retired.some(source => source.agentSessionId === id) && id !== relationOnly.agentSessionId) throw Error('Unknown private conversation participant')
  return { agentSessionId: id, sourceHostId: hostId, revision: 0, items: [], stream: { epoch: 'fixture-empty-' + id, revision: 0, sequence: 0, origin: 'beginning', gaps: [], positions: [] } }
}
function conversation(input: ConversationTimelineReadInput) {
  const timeline = originalTimeline(input.agentSessionId)
  const projected = projectConversationTimeline({ agentSessionId: input.agentSessionId, executionHostId: hostId, timeline })
  const checkpoint = { hostId, agentSessionId: input.agentSessionId, sourceHostId: hostId,
    frontier: { hostId, agentSessionId: input.agentSessionId, scope: projected.scope,
      cuts: [{ kind: 'captured' as const, epoch: timeline.stream!.epoch, sequence: timeline.stream!.sequence }] } }
  const units = [...projected.events].reverse().map(event => ({ kind: 'item' as const, item: { event, records: projected.records.filter(record => event.recordIds.includes(record.id)) } }))
  return parseConversationReadPage({ hostId, agentSessionId: input.agentSessionId, sourceHostId: hostId, scope: projected.scope,
    coverage: projected.coverage, order: { ...projected.order, direction: 'newest-first' }, items: units, nextCursor: null,
    budgetBytes: input.maxBytes ?? 65536, window: { id: 'fixture-window-' + input.agentSessionId, revision: 1, itemCount: units.length,
      complete: true, view: 'fixture-view-' + input.agentSessionId, replay: 'fixture-replay', checkpoint,
      outside: { older: null, newer: null }, navigation: { older: null, newer: null } } }, input)
}
api.conversation.readAgentConversation = async input => { reads.push({ kind: 'conversation', participant: input.agentSessionId }); return conversation(input) }
api.conversation.readConversationChanges = async input => { const page = conversation(input); return { ...page, checkpoint: page.window.checkpoint, more: false } }
api.conversation.observeConversation = async input => {
  const page = conversation(input), closed = new AbortController()
  return { hostId, agentSessionId: input.agentSessionId, sourceHostId: hostId, scope: page.scope, coverage: page.coverage, closed: closed.signal, dispose() { closed.abort() } }
}
api.conversation.releaseConversationView = async input => ({ hostId, agentSessionId: input.agentSessionId, sourceHostId: hostId, viewId: input.view, released: true })
const reference = (messageId: string, senderSessionId: string, recipientSessionId: string) => ({ messageId, senderSessionId, recipientSessionId, threadId: messageId, replyTo: null })
const refs = [reference('fixture-request', 'fixture-ui', 'fixture-core'), reference('fixture-review-request', 'fixture-core', 'fixture-review'), reference('fixture-design-question', 'fixture-ui', 'fixture-design'), reference('fixture-return-report', 'fixture-core', 'fixture-ui'), ...terrainSessions.flatMap((session, index) => [reference('fixture-terrain-message-' + index, session.id, index === 0 ? 'fixture-terrain-a' : index === 1 ? 'fixture-terrain-b' : 'fixture-core')])]
if (terrainSessions.length) refs.push(reference('fixture-terrain-followup-1', 'fixture-terrain-a', 'fixture-terrain-b'), reference('fixture-terrain-followup-2', 'fixture-terrain-a', 'fixture-terrain-b'))
const events: AgentMuxMessageEvent[] = [
  { sequence: 1, kind: 'message', at: now - 9000, messages: [refs[0]!] },
  { sequence: 2, kind: 'message', at: now - 8000, messages: [refs[1]!] },
  { sequence: 3, kind: 'message', at: now - 7000, messages: [refs[2]!] },
  { sequence: 4, kind: 'delivery', state: 'delivered', at: now - 6000, messages: [refs[0]!] },
  { sequence: 5, kind: 'dispatch-open', at: now - 5000, messages: [refs[0]!] },
  { sequence: 6, kind: 'message', at: now - 4000, messages: [refs[3]!] }
]
const adaptiveSubjects = new Set<string>()
for (const ref of refs.slice(4)) events.push({ sequence: events.at(-1)!.sequence + 1, kind: 'message', at: now - 3500, messages: [ref] })
if (terrainSessions.length) events.push({ sequence: events.at(-1)!.sequence + 1, kind: 'delivery', state: 'delivered', at: now - 3200, messages: [refs.at(-1)!] })
const denseSenders = extraSessions.slice(0, 88).filter(session => session.workspacePath === projects[0]!.path).slice(0, 12)
const densePeers = extraSessions.slice(singletonProjects.length, 88).filter(session => session.workspacePath !== projects[0]!.path && session.processState === 'running').slice(0, 12)
if (denseSenders.length !== 12 || densePeers.length !== 12) throw Error('The declared cross-area collaboration input must be nonempty and complete')
const denseRefs: ReturnType<typeof reference>[] = []
for (let sender = 0; sender < (scenario === 'endpoints' ? 0 : denseSenders.length); sender++) for (let offset = 0; offset < 3; offset++) {
  const ref = reference(`fixture-dense-${sender}-${offset}`, denseSenders[sender]!.id, densePeers[(sender + offset) % densePeers.length]!.id)
  denseRefs.push(ref); refs.push(ref)
  events.push({ sequence: events.at(-1)!.sequence + 1, kind: 'message', at: now - 3000, messages: [ref] })
  if (offset === 0 && sender % 4 === 0) events.push({ sequence: events.at(-1)!.sequence + 1, kind: 'dispatch-open', at: now - 2000, messages: [ref] })
}
let failEvents = false
api.sessions.messageEvents = async (subject, options = {}) => {
  reads.push({ kind: 'events', participant: subject.agentSessionId, options: structuredClone(options) })
  if (failEvents && subject.agentSessionId === 'fixture-core') throw Error('The original fixture message source is temporarily unavailable. Existing work is retained.')
  queueMicrotask(() => { for (const listener of listeners) listener({ type: 'core', hostId, event: { type: 'agent-message-observation', state: 'available' } }) })
  const throughSequence = options.throughSequence ?? events.at(-1)!.sequence
  let selected = events.filter(event => event.sequence <= throughSequence && event.messages.some(message => (message.senderSessionId === subject.agentSessionId || message.recipientSessionId === subject.agentSessionId) && (!options.messageId || options.messageId === message.messageId)))
  if (options.beforeSequence !== undefined) selected = selected.filter(event => event.sequence < options.beforeSequence!)
  else if (options.afterSequence !== undefined) selected = selected.filter(event => event.sequence > options.afterSequence!)
  // The adaptive scene uses a normal bounded metadata page. Earlier pagination
  // scenarios retain their original four-record platform pages unchanged.
  const backward = options.latest === true || options.beforeSequence !== undefined, limit = Math.min(options.limit ?? 50, adaptiveSubjects.has(subject.agentSessionId) ? 50 : 4)
  const more = selected.length > limit
  selected = backward ? selected.slice(-limit) : selected.slice(0, limit)
  const input = { ...options, participantSessionId: subject.agentSessionId }
  return { ...parseMessageEventsPage({ participantSessionId: subject.agentSessionId, afterSequence: options.afterSequence ?? 0,
    latest: options.latest ?? false, beforeSequence: options.beforeSequence ?? null, throughSequence, incarnation,
    messageId: options.messageId ?? null, broadcastOperationId: null, events: selected,
    nextAfterSequence: !backward && more ? selected.at(-1)!.sequence : null,
    nextBeforeSequence: backward && more ? selected[0]!.sequence : null }, input), hostId: subject.hostId }
}
const creation: AgentMuxSpawnRecord = { agentSessionId: 'fixture-core', phase: 'active', currentRun: { runId: 'fixture-run-fixture-core' }, createdAt: now - 50000,
  creation: { createOperationId: 'fixture-creation', initialPrompt: 'not-requested', createdRun: { runId: 'fixture-run-fixture-core' },
    createdBy: { agentSessionId: 'fixture-ui', run: { runId: 'fixture-run-fixture-ui' }, owner: { kind: 'local' } } } }
const creations: AgentMuxSpawnRecord[] = [creation, ...(scenario === 'endpoints' ? [] : densePeers.slice(0, 4)).map((session, index): AgentMuxSpawnRecord => ({ agentSessionId: session.id, phase: 'active', currentRun: session.control.run, createdAt: now - 10000,
  creation: { createOperationId: 'fixture-dense-creation-' + index, initialPrompt: 'not-requested', createdRun: session.control.run,
    createdBy: { agentSessionId: denseSenders[index]!.id, run: denseSenders[index]!.control.run, owner: { kind: 'local' } } } }))]
// Prepared is only a recorded target reference: deliberately absent from both
// the current snapshot and retained-history catalog. No Run is invented.
if (scenario === 'endpoints') for (const phase of ['prepared', 'retired'] as const) creations.push({
  agentSessionId: 'fixture-endpoint-' + phase, phase, currentRun: null, createdAt: now - 12000,
  creation: { createOperationId: 'fixture-endpoint-operation-' + phase, initialPrompt: 'not-requested',
    createdBy: { agentSessionId: 'fixture-ui', run: { runId: 'fixture-run-fixture-ui' }, owner: { kind: 'local' } } }
})
api.sessions.spawns = async (subject, options) => {
  reads.push({ kind: 'spawns', participant: subject.agentSessionId, options: structuredClone(options) })
  const matches = creations.filter(record => options.direction === 'created' ? record.creation?.createdBy?.agentSessionId === subject.agentSessionId : record.agentSessionId === subject.agentSessionId)
  return { hostId: subject.hostId, participantSessionId: subject.agentSessionId, direction: options.direction, creatorRuntimeId: null,
    records: matches, nextCursor: null, coverage: { scope: 'selected-owner', history: 'recorded-creations' } }
}
api.sessions.dispatches = async subject => ({ hostId: subject.hostId, participantSessionId: subject.agentSessionId, dispatches: [], nextSourceMessageId: null })
api.sessions.readMessage = async (subject, mid) => {
  reads.push({ kind: 'body', participant: subject.agentSessionId, options: mid })
  const ref = refs.find(ref => ref.messageId === mid)
  if (!ref) throw Error('Unknown private source message')
  return { hostId: subject.hostId, message: { sequence: events.find(event => event.kind === 'message' && event.messages[0]?.messageId === mid)!.sequence,
    envelope: { ...ref, schema: 'agentmux.a2a.v1', operationId: 'fixture-operation-' + mid, body: 'Inspect the original delivery boundary and report any concrete issue. Keep existing work and authorization.', createdAt: now - 9000,
      sender: { kind: 'agent-session', agentSessionId: ref.senderSessionId }, recipient: { kind: 'agent-session', agentSessionId: ref.recipientSessionId },
      senderRunId: 'fixture-run-' + ref.senderSessionId, recipientRunId: null, workspaceId: null, correlationId: mid }, delivery: { state: 'delivered', at: now - 6000 } } }
}
createClientUiRoot(document.getElementById('root')!).render(createElement(App))
let originalState: ReturnType<typeof useAppStore.getState> | undefined, originalDraft: HTMLTextAreaElement | null = null, originalMap: Element | null = null, originalBody: HTMLElement | null = null
const structuralValue = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
type CaptureTabs = ReturnType<typeof useAppStore.getState>['tabs']
let originalTabBaseline: { tabs: CaptureTabs; regions: Map<string, Map<string, CaptureTabs[string]['regions'][string]>>; shape: string } | undefined
function originalTabProtection(tabs: CaptureTabs) {
  const baseline = originalTabBaseline
  return {
    sameTabKeys: Boolean(baseline && structuralValue(Object.keys(tabs).sort()) === structuralValue(Object.keys(baseline.tabs).sort())),
    sameTabObjects: Boolean(baseline && Object.entries(baseline.tabs).every(([id, tab]) => tabs[id] === tab)),
    sameRegionKeys: Boolean(baseline && [...baseline.regions].every(([id, regions]) => tabs[id] && structuralValue(Object.keys(tabs[id]!.regions).sort()) === structuralValue([...regions.keys()].sort()))),
    sameRegionObjects: Boolean(baseline && [...baseline.regions].every(([id, regions]) => [...regions].every(([regionId, region]) => tabs[id]?.regions[regionId] === region))),
    tabsPreserved: Boolean(baseline && structuralValue(tabs) === baseline.shape)
  }
}
function visibleSurfaces(selector: string) {
  return [...document.querySelectorAll<HTMLElement>(selector)].flatMap(element => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element)
    return rect.width > 0 && rect.height > 0 && !element.closest('[hidden],[inert]') && style.visibility === 'visible' && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth
      ? [{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }] : []
  })
}
const adaptiveProjects: WorkspaceRecord[] = [
  { id: 'fixture-adaptive-root', hostId, name: '协作邻域', path: fixturePath('private/graph/adaptive'), kind: 'folder' },
  { id: 'fixture-adaptive-middle', hostId, name: '相关成员', path: fixturePath('private/graph/adaptive/work'), kind: 'folder' },
  { id: 'fixture-adaptive-work', hostId, name: '结构调整', path: fixturePath('private/graph/adaptive/work/members'), kind: 'folder' },
  { id: 'fixture-adaptive-control', hostId, name: '独立对照', path: fixturePath('private/graph/adaptive-control'), kind: 'folder' },
  { id: 'fixture-adaptive-holding', hostId, name: '已移出成员', path: fixturePath('private/graph/adaptive-holding'), kind: 'folder' }
]
let adaptiveSessions: Array<Extract<SessionSnapshot, { kind: 'agent' }>> = []
const adaptiveArea = (index: number) => collaborationAreaNode(directoryIdentity(hostId, adaptiveProjects[index]!.path))
const adaptiveOccurrence = (session: Extract<SessionSnapshot, { kind: 'agent' }>) => collaborationAgentNode(directoryIdentity(hostId, session.workspacePath), JSON.stringify([hostId, session.id]))
const adaptiveObserver = createAdaptivePresentationObserver(() => new Set([...adaptiveProjects.map((_, index) => adaptiveArea(index)),
  ...adaptiveSessions.flatMap(session => [adaptiveOccurrence(session), collaborationAgentNode(directoryIdentity(hostId, adaptiveProjects[2]!.path), JSON.stringify([hostId, session.id]))])]),
  () => new Map([[adaptiveArea(1), adaptiveArea(0)], [adaptiveArea(2), adaptiveArea(1)]]))
function adaptiveSession(id: string, project: WorkspaceRecord, label: string): Extract<SessionSnapshot, { kind: 'agent' }> {
  const observedAt = Date.now(), run = { runId: 'fixture-run-' + id }, nativeSessionId = 'native-' + id
  return { ...plainBase, id, label, providerId: 'codex', executorId: 'codex', hostId, workspacePath: project.path, nativeSessionId,
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: nativeSessionId }, createdAt: observedAt, updatedAt: observedAt, agentSessionUpdatedAt: observedAt,
    processState: 'running', status: { state: 'done', source: 'native-hook', observedAt },
    semanticStatus: { state: 'done', source: 'native-hook', observedAt, stateEnteredAt: observedAt, currentActivityRevision: 1 },
    currentActivity: { state: 'idle', source: 'native-hook', run, nativeSessionId, nativeTurnId: 'turn-' + id, sourceId: 'source-' + id, sequence: 1, hookReceiptId: 'receipt-' + id, observedAt },
    control: { kind: 'agent', hostId, agentSessionId: id, run } }
}
function publishAdaptiveSession(session: Extract<SessionSnapshot, { kind: 'agent' }>) {
  sessions = [...sessions.filter(candidate => candidate.id !== session.id), session]
  adaptiveSessions = [...adaptiveSessions.filter(candidate => candidate.id !== session.id), session]
  adaptiveSubjects.add(session.id)
  const record: AgentMuxAgentSession = { kind: 'agent', agentSessionId: session.id, providerId: session.providerId, executorId: session.executorId, hostId,
    workspacePath: session.workspacePath, run: session.control.run, retiredRuns: [], createdAt: session.createdAt, updatedAt: session.agentSessionUpdatedAt,
    semanticStatus: session.semanticStatus, currentActivity: session.currentActivity, ...(session.nativeHandle ? { nativeHandle: session.nativeHandle } : {}) }
  for (const listener of listeners) listener({ type: 'core', hostId, event: { type: 'agent-session', session: record } })
}
function adaptiveMessage(sender: string, recipient: string, id: string, notify = false) {
  const message = reference(id, sender, recipient), sequence = events.at(-1)!.sequence + 1
  refs.push(message); events.push({ sequence, kind: 'message', at: Date.now() - 10000, messages: [message] })
  if (notify) for (const listener of listeners) listener({ type: 'core', hostId, event: { type: 'agent-message-changed', messageId: id, senderSessionId: sender, recipientSessionId: recipient, sequence, messageSequence: sequence, recordKind: 'message', live: false } })
  return { id, sequence, sender, recipient, hostId, live: false }
}
Object.assign(window, { graphCapture: {
  ready: true, reads, controls, census, beginMeasurement, endMeasurement,
  diagnosticPhase(value: string) { diagnosticPhase = value },
  rendererDiagnostics() { return { errors: rendererDiagnostics, resizeConstructors, resizeCallbackBatches, resizeObserverCount: resizeObserverSequence, resizeObservationMS,
    limits: { batches: 16, targetsPerBatch: 32, constructors: 256 }, boundary: 'Finite fixture-only native ResizeObserver payload/constructor observation; original callback, scheduling, observe/disconnect and window errors unchanged. No layout reads. Additional clock/attribute/stack costs are recorded, not calibrated or subtracted from product timings.' } },
  async publicControl(request: Parameters<NonNullable<typeof admittedControl>>[0]) {
    if (!admittedControl || request.operation !== 'focus' && request.operation !== 'inspect.client') throw Error('Original public callback unavailable for this finite scene')
    const controller = new AbortController(); publicSignals.set(request.requestId, controller)
    publicRequests.push({ id: request.requestId, operation: request.operation })
    try { return await admittedControl(request, controller.signal) } finally { publicSignals.delete(request.requestId) }
  },
  cancelPublicControl(requestId: string) { publicSignals.get(requestId)?.abort() },

  rememberMap() { const current = document.querySelector('.collaboration-map'); if (originalMap && current !== originalMap) throw Error('The original map owner was replaced'); originalMap = current },
  distribution() { return { emptyProjectIds: emptyProjects.map(project => project.id), singletonProjectIds: singletonProjects.map(project => project.id),
    denseSubjects: [...denseSenders, ...densePeers].map(session => ({ hostId, agentSessionId: session.id })),
    denseCommunication: denseRefs.map(ref => ({ messageId: ref.messageId, sender: JSON.stringify([hostId, ref.senderSessionId]), recipient: JSON.stringify([hostId, ref.recipientSessionId]) })),
    expectedInitialAgentKeys: [...initialSessions.map(session => JSON.stringify([session.hostId, session.kind === 'agent' ? session.control.agentSessionId : session.id])), ...retired.map(source => JSON.stringify([source.hostId, source.agentSessionId]))],
    projectAreaId: projectSpace, projectAreaNodeId: collaborationAreaNode(projectSpace), retainedSubjects: retired.map(source => ({ hostId: source.hostId, agentSessionId: source.agentSessionId, workspacePath: source.history?.workspacePath })),
    initialCanonicalAgents: initialSessions.length + retired.length, permanentEmptyAreas: emptyProjects.length,
    emptyAreaNodeIds: emptyProjects.map(project => collaborationAreaNode(directoryIdentity(project.hostId!, project.path))), initialSnapshotMembers: initialSessions.length } },
  clearFocusForEntry() { useAppStore.getState().focusExecutionSession(null, undefined, { navigate: false }) },
  rememberBody() {
    originalBody = document.querySelector('.collaboration-evidence .composer-mailbox__detail .log-turn__body')
    if (!originalBody) throw Error('Original message body must exist before measuring its preservation')
    const range = document.createRange(); range.selectNodeContents(originalBody)
    const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range)
    return { text: originalBody.textContent, selection: selection?.toString(), messageId: originalBody.closest<HTMLElement>('[data-message-id]')?.dataset.messageId }
  },
  bodyState() { return { connected: originalBody?.isConnected, sameBody: originalBody === document.querySelector('.collaboration-evidence .composer-mailbox__detail .log-turn__body'), text: originalBody?.textContent, selection: getSelection()?.toString(), messageId: originalBody?.closest<HTMLElement>('[data-message-id]')?.dataset.messageId } },
  workerSamples() { return structuredClone(nativeWorkers) },
  deliveredLayout() {
    const layout = (globalThis as typeof globalThis & { __collaborationCaptureLayout?: { boxes: ReadonlyMap<string, unknown>; paths: ReadonlyMap<string, unknown>; busy: boolean; transitioning: boolean; issues: ReadonlyMap<string, string> } }).__collaborationCaptureLayout
    return layout ? structuredClone({ boxes: [...layout.boxes.values()], pathIds: [...layout.paths.keys()], busy: layout.busy, transitioning: layout.transitioning, issues: [...layout.issues] }) : null
  },
  async adaptivePrepare() {
    if (adaptiveSessions.length) throw Error('Use one new adaptive scene')
    const before = await api.config.get()
    projects.push(...adaptiveProjects)
    await api.config.save({ ...before, workspaces: [...before.workspaces, ...adaptiveProjects] }, before)
    for (let index = 0; index < 12; index++) adaptiveSessions.push(adaptiveSession('fixture-adaptive-' + String(index).padStart(2, '0'), adaptiveProjects[2]!, '成员 ' + String(index).padStart(2, '0')))
    adaptiveSessions.push(adaptiveSession('fixture-adaptive-control', adaptiveProjects[3]!, '独立对照成员'))
    const members = [...adaptiveSessions]
    for (let index = 0; index < 11; index++) adaptiveMessage(members[index]!.id, members[index + 1]!.id, 'fixture-adaptive-chain-' + index)
    for (const session of members) publishAdaptiveSession(session)
    return { areas: adaptiveProjects.map((project, index) => ({ id: adaptiveArea(index), name: project.name, workspaceId: project.id })),
      members: members.slice(0, 12).map(session => ({ id: session.id, nodeId: adaptiveOccurrence(session), runId: session.control.run.runId })),
      reader: members[0]!.id, control: { id: members[12]!.id, nodeId: adaptiveOccurrence(members[12]!), areaId: adaptiveArea(3) },
      boundary: 'Only private typed platform Session/config/message facts; original App initialization, membership owner, read budgets, Graph and Worker remain intact.' }
  },
  adaptiveAdd(farthest: string) {
    const reader = adaptiveSessions.find(session => session.id === 'fixture-adaptive-00'), peer = adaptiveSessions.find(session => session.id === farthest)
    if (!reader || !peer || peer.id === reader.id || adaptiveSubjects.has('fixture-adaptive-new')) throw Error('Exact distinct original adaptive endpoints required')
    const session = adaptiveSession('fixture-adaptive-new', adaptiveProjects[2]!, '新增协作成员'), evidence = []
    adaptiveSubjects.add(session.id)
    for (let index = 0; index < 32; index++) for (const target of [reader, peer]) evidence.push(adaptiveMessage(session.id, target.id, 'fixture-adaptive-new-' + target.id + '-' + index, true))
    publishAdaptiveSession(session)
    return { member: { id: session.id, nodeId: adaptiveOccurrence(session), runId: session.control.run.runId }, evidence }
  },
  adaptiveRemoveMember(id: string) {
    const original = adaptiveSessions.find(session => session.id === id)
    if (!original || id === 'fixture-adaptive-00' || id === 'fixture-adaptive-control' || original.workspacePath !== adaptiveProjects[2]!.path) throw Error('Only the selected original non-reader work member can move')
    const session = { ...original, workspacePath: adaptiveProjects[4]!.path, updatedAt: Date.now(), agentSessionUpdatedAt: Date.now() }
    publishAdaptiveSession(session)
    return { id, oldNodeId: adaptiveOccurrence(original), nodeId: adaptiveOccurrence(session), runId: session.control.run.runId, boundary: 'The exact Session/Run remains present in its new actual membership; no Session is terminated or deleted and no original message is removed.' }
  },
  adaptiveTier(id: string, active: boolean) {
    const original = adaptiveSessions.find(session => session.id === id)
    if (!original || id === 'fixture-adaptive-00' || id === 'fixture-adaptive-control') throw Error('The original Reader and control do not change footprint')
    const observedAt = Date.now(), sequence = (original.currentActivity?.sequence ?? 0) + 1, state = active ? 'working' as const : 'done' as const
    const session = { ...original, updatedAt: observedAt, agentSessionUpdatedAt: observedAt,
      status: { state, source: 'native-hook' as const, observedAt }, semanticStatus: { state, source: 'native-hook' as const, observedAt, stateEnteredAt: observedAt, currentActivityRevision: sequence },
      currentActivity: { ...original.currentActivity!, state: active ? 'active' as const : 'idle' as const, sequence, observedAt, hookReceiptId: 'receipt-' + id + '-' + sequence } }
    publishAdaptiveSession(session); return { id, nodeId: adaptiveOccurrence(session), active, sequence, runId: session.control.run.runId }
  },
  adaptiveRemember() { const anchor = document.querySelector<HTMLElement>('.collaboration-agent__identity-layer:not([inert]) [data-session-id="fixture-adaptive-00"]'); if (!anchor) throw Error('Original adaptive identity owner must be visible'); return adaptiveObserver.remember(anchor) },
  adaptiveRememberFocus() { adaptiveObserver.rememberFocus() },
  adaptiveStatus() { return { ...adaptiveObserver.status(), workers: nativeWorkers.length, reading: Boolean(document.querySelector('.collaboration-map__reading')) } },
  adaptiveSample: adaptiveObserver.sample, adaptiveTraceStart: adaptiveObserver.start, adaptiveTraceStop: adaptiveObserver.stop,
  activityMS: COLLABORATION_ACTIVITY_MS,
  delayRoutes(milliseconds: number, sender = 'fixture-core', recipient = 'fixture-design') { if (![0, 1200, 3600].includes(milliseconds)) throw Error('Use a declared finite transport delay'); delayedRoute = milliseconds ? { milliseconds, sender, recipient } : undefined },
  activity() {
    const screen = (element: Element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, onscreen: r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight } }
    const animation = (element: Element) => { const a = element.getAnimations()[0], style = getComputedStyle(element); return { currentTime: a?.currentTime ?? null, delay: a?.effect?.getTiming().delay ?? null, progress: a?.effect?.getComputedTiming().progress ?? null, duration: style.animationDuration, opacity: style.opacity, display: style.display, animationName: style.animationName, dashoffset: style.strokeDashoffset } }
    return { at: performance.now(), reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      markers: [...document.querySelectorAll('.collaboration-activity')].map(element => ({ subject: element.closest<HTMLElement>('[data-collaboration-agent]')?.dataset.collaborationAgent, label: element.getAttribute('aria-label'), kind: element.getAttribute('data-kind'), ...animation(element), ...screen(element) })),
      paths: [...document.querySelectorAll('.collaboration-edge__pulse')].map(element => ({ id: element.closest<HTMLElement>('[data-id]')?.dataset.id, kind: element.getAttribute('data-kind'), path: element.getAttribute('d'), ...animation(element), ...screen(element) })),
      packets: [...document.querySelectorAll('.collaboration-edge__packet')].map(element => ({ id: element.closest<HTMLElement>('[data-id]')?.dataset.id, kind: element.getAttribute('data-kind'), distance: getComputedStyle(element).offsetDistance, ...animation(element), ...screen(element) })) }
  },
  world() {
    const layout = (globalThis as typeof globalThis & { __collaborationCaptureLayout?: { boxes: ReadonlyMap<string, unknown> } }).__collaborationCaptureLayout
    return { camera: document.querySelector('.collaboration-map .react-flow__viewport')?.getAttribute('style'), geometry: structuredClone([...(layout?.boxes.values() ?? [])]),
      nodes: [...document.querySelectorAll<HTMLElement>('.collaboration-map .react-flow__node')].map(element => { const r = element.getBoundingClientRect(); return { id: element.dataset.id, transform: element.style.transform, x: r.x, y: r.y, width: r.width, height: r.height } }),
      reader: (() => { const element = document.querySelector('.agent-information-reader'); if (!element) return null; const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, subject: element.getAttribute('data-agent-session-id'), pinned: Boolean(document.querySelector('[aria-label="Remove Agent bookmark"]')) } })() }
  },
  reviseSession(id: string) {
    const index = sessions.findIndex(session => session.kind === 'agent' && session.control.agentSessionId === id), original = sessions[index]
    if (!original || original.kind !== 'agent') throw Error('Only an original fixture Session can receive a metadata update')
    const observedAt = Date.now(), sequence = (original.currentActivity?.sequence ?? 0) + 1
    const session = { ...original, updatedAt: observedAt, agentSessionUpdatedAt: observedAt,
      status: { state: 'working' as const, source: 'native-hook' as const, observedAt },
      semanticStatus: { state: 'working' as const, source: 'native-hook' as const, observedAt, stateEnteredAt: observedAt, currentActivityRevision: sequence },
      currentActivity: { state: 'active' as const, source: 'native-hook' as const, run: original.control.run, nativeSessionId: original.nativeSessionId!, nativeTurnId: 'turn-' + id, sourceId: 'source-' + id, sequence, hookReceiptId: 'receipt-' + id + '-' + sequence, observedAt } }
    sessions = [...sessions.slice(0, index), session, ...sessions.slice(index + 1)]
    const catalogIndex = extraSessions.findIndex(candidate => candidate.id === id)
    if (catalogIndex >= 0) extraSessions[catalogIndex] = session
    const record: AgentMuxAgentSession = { kind: 'agent', agentSessionId: id, providerId: session.providerId, executorId: session.executorId, hostId,
      workspacePath: session.workspacePath, run: session.control.run, retiredRuns: [], createdAt: session.createdAt, updatedAt: observedAt, semanticStatus: session.semanticStatus, currentActivity: session.currentActivity, ...(session.nativeHandle ? { nativeHandle: session.nativeHandle } : {}) }
    for (const listener of listeners) listener({ type: 'core', hostId, event: { type: 'agent-session', session: record } })
    return { id, observedAt, currentActivityRevision: sequence }
  },
  grow(total: 240 | 480) {
    const start = performance.now()
    if (total !== 240 && total !== 480) throw Error('Use one declared finite size')
    const added = extraSessions.slice(0, total - originalSessions.length - terrainSessions.length - retired.length)
    sessions = [...originalSessions, ...terrainSessions, ...added]
    for (let index = 0; index + 1 < added.length; index += 12) {
      const messageId = 'fixture-sparse-' + index
      if (refs.some(ref => ref.messageId === messageId)) continue
      const ref = reference(messageId, added[index]!.id, added[index + 1]!.id)
      refs.push(ref); events.push({ sequence: events.at(-1)!.sequence + 1, kind: 'message', at: now - 3000, messages: [ref] })
    }
    const latest = added.at(-1)
    if (!latest || latest.kind !== 'agent') throw Error('Nonempty original Agent membership sample required')
    const session: AgentMuxAgentSession = { kind: 'agent', agentSessionId: latest.control.agentSessionId, providerId: latest.providerId, executorId: latest.executorId, hostId,
      workspacePath: latest.workspacePath, run: latest.control.run, retiredRuns: [], createdAt: latest.createdAt, updatedAt: latest.agentSessionUpdatedAt,
      ...(latest.semanticStatus ? { semanticStatus: latest.semanticStatus } : {}), ...(latest.currentActivity ? { currentActivity: latest.currentActivity } : {}), ...(latest.nativeHandle ? { nativeHandle: latest.nativeHandle } : {}) }
    for (const listener of listeners) listener({ type: 'core', hostId, event: { type: 'agent-session', session } })
    return { expectedWorldAgents: sessions.length + retired.length, expectedAgentKeys: [...sessions.map(session => JSON.stringify([session.hostId, session.kind === 'agent' ? session.control.agentSessionId : session.id])), ...retired.map(source => JSON.stringify([source.hostId, source.agentSessionId]))], snapshotMembers: sessions.length, retiredMembers: retired.length, unassociatedMembers: added.filter(session => !refs.some(ref => ref.senderSessionId === session.id || ref.recipientSessionId === session.id)).length, nativeActivityCounts: { active: sessions.filter(session => session.kind === 'agent' && session.currentActivity?.state === 'active').length, idle: sessions.filter(session => session.kind === 'agent' && session.currentActivity?.state === 'idle').length, unknown: sessions.filter(session => session.kind === 'agent' && session.currentActivity?.state === 'unknown').length, exited: sessions.filter(session => session.processState === 'exited').length }, fixtureMutationMS: performance.now() - start }
  },
  endpoints() {
    if (scenario !== 'endpoints') throw Error('Only the declared endpoint scenario may expose its typed input')
    const prepared = 'fixture-endpoint-prepared', closed = 'fixture-endpoint-retired'
    return { hostId, source: 'fixture-ui', active: 'fixture-core', prepared, retired: closed,
      names: Object.fromEntries(identities.map(([id, name]) => [id, name])), records: structuredClone(creations),
      snapshotIds: sessions.map(session => session.id), historyIds: retired.map(source => source.agentSessionId),
      unplacedArea: collaborationAreaNode('retained-unplaced'),
      boundary: 'Synthetic original spawn/message pages only. Prepared has no Session descriptor or Run; retired has no workspace or current Run. Original projector, grouping, Graph and input owners remain unchanged.' }
  },
  terrain() { return { areas: terrainProjects.map(project => ({ id: directoryIdentity(hostId, project.path), name: project.name })), agents: terrainSessions.map(session => ({ id: session.id, name: session.label, areaId: directoryIdentity(session.hostId, session.workspacePath) })) } },
  prepare() {
    useAppStore.setState({ activeWorkspaceId: projects[0]!.id, mainSurface: 'workbench', toolsOpen: true, projectRailOpen: true,
      ...(perception ? { spaceObjectIcons: { ...useAppStore.getState().spaceObjectIcons, [topicSpaceIconTarget(scratch, topics[1]!, bindings)!.key]: { ...DEFAULT_MOTE_FACE, palette: 'peach' as const, accessory: 'glasses' as const } } } : {}),
      agentNames: Object.fromEntries(identities.map(([id, name]) => [id, name])), agentComposerDrafts: { 'fixture-ui': 'Original unsent reply · retain this exact draft.' } })
    useAppStore.getState().focusRegion(projects[0]!.id, 'tab-fixture-ui', 'region-fixture-ui', 'pointer', 'group-0')
  },
  remember() {
    originalState = useAppStore.getState()
    // Core spatial publication can rebuild only the outer dictionary. Protect
    // every original workface object and immutable content, without rebasing it
    // after the adaptive fixture's explicit configuration or membership input.
    originalTabBaseline = { tabs: { ...originalState.tabs }, shape: structuralValue(originalState.tabs),
      regions: new Map(Object.entries(originalState.tabs).map(([id, tab]) => [id, new Map(Object.entries(tab.regions))])) }
    originalDraft = document.querySelector('[data-fixture-session="fixture-ui"] textarea'); originalDraft?.setSelectionRange(4, 12)
  },
  async appearance(appAppearance: 'dark' | 'light') { const before = await api.config.get(); await api.config.save({ ...before, appearance: { ...before.appearance, appAppearance } }, before) },
  preferences() { return structuredClone(useAppStore.getState().config?.focus) },
  fail(value: boolean) { failEvents = value },
  live(live = true, sender = 'fixture-core', recipient = 'fixture-ui', kind: 'message' | 'dispatch-open' = 'message') {
    const sequence = events.at(-1)!.sequence + 1, mid = 'fixture-live-' + sequence, ref = reference(mid, sender, recipient)
    refs.push(ref); events.push({ sequence, kind, at: Date.now(), messages: [ref] })
    const at = performance.now()
    for (const listener of listeners) listener({ type: 'core', hostId, event: { type: 'agent-message-changed', messageId: mid, senderSessionId: ref.senderSessionId, recipientSessionId: ref.recipientSessionId, sequence, messageSequence: sequence, recordKind: kind, live } })
    return { at, hostId, sender, recipient, sequence, messageId: mid, kind, live }
  },
  facts() { const state = useAppStore.getState(), tabProtection = originalTabProtection(state.tabs); return { loading: state.loading, ids: state.sessions.map(session => session.id),
    sameTabs: Object.values(tabProtection).every(Boolean), sameTabTable: state.tabs === originalState?.tabs, ...tabProtection, sameLayouts: state.layouts === originalState?.layouts,
    ...(Object.values(tabProtection).every(Boolean) ? {} : { tabDifference: { before: originalTabBaseline ? JSON.parse(originalTabBaseline.shape) : null, after: state.tabs } }),
    layoutsPreserved: structuralValue(state.layouts) === structuralValue(originalState?.layouts),
    selectionPreserved: structuralValue(state.workbenchSpaceSelection) === structuralValue(originalState?.workbenchSpaceSelection),
    ...(structuralValue(state.layouts) === structuralValue(originalState?.layouts) ? {} : { layoutDifference: { before: originalState?.layouts, after: state.layouts } }),
    ...(structuralValue(state.workbenchSpaceSelection) === structuralValue(originalState?.workbenchSpaceSelection) ? {} : { selectionDifference: { before: originalState?.workbenchSpaceSelection, after: state.workbenchSpaceSelection } }),
    sameDrafts: state.agentComposerDrafts === originalState?.agentComposerDrafts, sameFocus: state.agentFocus === originalState?.agentFocus,
    sameSelection: state.workbenchSpaceSelection === originalState?.workbenchSpaceSelection,
    draftMounted: originalDraft?.isConnected, sameDraft: originalDraft === document.querySelector('[data-fixture-session="fixture-ui"] textarea'),
    draft: originalDraft?.value, storedDraft: state.agentComposerDrafts['fixture-ui'], range: [originalDraft?.selectionStart, originalDraft?.selectionEnd], reads: [...reads], controls: [...controls],
    selectedSession: state.agentFocus.execution.sessionId, originalRun: sessions[0]!.control.run.runId,
    metadata: state.sessions.map(session => ({ id: session.id, label: session.label, agentSessionUpdatedAt: session.kind === 'agent' ? session.agentSessionUpdatedAt : undefined, currentActivityRevision: session.kind === 'agent' ? session.semanticStatus?.currentActivityRevision : undefined, activity: session.kind === 'agent' ? session.currentActivity?.state : undefined })),
    sameMap: originalMap === document.querySelector('.collaboration-map'), census: census(),
    activeWorkspaceId: state.activeWorkspaceId, choice: structuredClone(state.workbenchSpaceSelection),
    documentHidden: document.hidden, visibilityState: document.visibilityState,
    focusAgentReveal: state.focusAgentReveal, publicAdmissionReady: Boolean(admittedControl), publicRequests: [...publicRequests], mainSurface: state.mainSurface, focusView: state.focusView, mapTarget: state.collaborationMapTarget, graph: Boolean(document.querySelector('.collaboration-map[data-desktop-focus-view="map"]:not([hidden])')),
    chrome: { viewportWidth: innerWidth, map: visibleSurfaces('[data-desktop-focus-view="map"]'), list: visibleSurfaces('[data-desktop-focus-view="list"]'), rail: visibleSurfaces('.project-rail-shell'), dock: visibleSurfaces('[data-surface-tool-dock]'), preferences: { toolsOpen: state.toolsOpen, projectRailOpen: state.projectRailOpen } },
    instrumentation: structuredClone(instrumentation()), readers: document.querySelectorAll('[data-agent-reading-host]').length } }
} })
