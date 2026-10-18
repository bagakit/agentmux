import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../../src/renderer/src/App'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { inspectConversationConsumers } from '../../../src/renderer/src/lib/conversation-consumer-observation'
import { api } from '../../../src/renderer/src/lib/api'
import { createConversationReadApi } from '../../../src/renderer/src/lib/conversation-read-api'
import { createRendererSessionEvents } from '../../../src/renderer/src/lib/session-events'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import { desktopSpatialGraph } from '../../../src/renderer/src/lib/desktop-spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import { draft, surfacePending } from './scene.mjs'
import '../../../src/renderer/src/styles/index.css'

const boundary = (window as any).readingBoundary, request = boundary.request
const errors: string[] = []
window.addEventListener('error', event => errors.push(event.error?.stack ?? event.message))
window.addEventListener('unhandledrejection', event => errors.push(event.reason?.stack ?? String(event.reason)))
const setup = await request('setup'), workspace = setup.config.workspaces[0]
api.config.get = async () => setup.config
api.providers.list = async (options?: any) => request('providers', options)
api.demands.list = async () => []
api.files.readDirectory = async () => []
api.files.observe = async () => {}
api.files.unobserve = async () => {}
api.scratch.listTopics = async () => []
api.workspaces.appearance = async () => ({ icon: null })
api.workspaces.listBranches = async () => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: workspace.path })
api.sessions.snapshot = async () => request('snapshot')
api.sessions.onEvent = createRendererSessionEvents(listener => boundary.onEvent(listener))
for (const name of ['attach', 'detach', 'replay', 'resize', 'resolve', 'refresh', 'recover', 'historyPage', 'timeline', 'historySource', 'historySources', 'historyResource', 'inputMailbox'] as const) {
  (api.sessions as any)[name] = (...args: unknown[]) => request(name, ...args)
}
api.sessions.readHistory = (reference, input) => request('readHistory', reference, input)
// These proof scenes contain no send intent. Any accidental control crosses a failing boundary.
api.sessions.write = (...args) => request('terminal-protocol', ...args)
for (const name of ['paste', 'stop', 'submitPrompt', 'respondInteraction'] as const) {
  (api.sessions as any)[name] = (...args: unknown[]) => request('unexpected-control', name, ...args)
}
api.ui.writeClipboardText = async text => request('copy', text)
api.ui.requestStorageFlush = async () => request('flush')
api.spatial.read = async () => request('spatial-read')
api.spatial.commit = input => request('spatial-commit', input)
api.spatial.onChange = listener => boundary.onSpatial(listener)
const events: unknown[] = []
const mark = (type: string, detail?: unknown) => {
  const feed = document.querySelector<HTMLElement>('.activity-feed')
  const selected = (window as any).readingSelectedBody as HTMLElement | undefined
  events.push({ type, at: performance.now(), detail, top: feed?.scrollTop, height: feed?.scrollHeight,
    selectedTop: selected?.isConnected ? selected.getBoundingClientRect().top : null,
    selection: getSelection()?.toString(), selectedConnected: selected?.isConnected })
}
for (const type of ['wheel', 'scroll', 'selectionchange']) document.addEventListener(type, event => {
  if (type === 'selectionchange' || event.target instanceof Element && event.target.closest('.activity-feed'))
    mark(type, event instanceof WheelEvent ? { deltaY: event.deltaY, trusted: event.isTrusted } : undefined)
}, { capture: true, passive: true })
let olderCursor: string | undefined, nativeCut: string | undefined
let released: { cursor: string; returned?: { id: string; revision: number } } | undefined
let held: { cursor: string; received: boolean; release?: () => void } | undefined
const reads: unknown[] = [], reader = createConversationReadApi(boundary.conversation)
Object.assign(api.conversation, reader)
for (const method of ['readAgentConversation', 'readConversationChanges'] as const) {
  api.conversation[method] = (async (input: any, options: any) => {
    const started = performance.now()
    mark('read-start', { method, input })
    const result = await (reader[method] as any)(input, options)
    if (held && held.cursor === input.cursor) {
      const hold = held; hold.received = true; mark('held-earlier-response')
      await new Promise<void>(resolve => { hold.release = resolve })
    }
    const native = result.window?.checkpoint?.frontier?.cuts?.find((cut: any) => cut.kind === 'native')
    if (native) nativeCut = native.checkpoint.cursor
    if (result.window?.navigation?.older) olderCursor = result.window.navigation.older
    mark('read-end', { method, input, window: result.window })
    if (released && released.cursor === input.cursor) released.returned = { id: result.window.id, revision: result.window.revision }
    reads.push({ method, started, ended: performance.now(), input, window: result.window, records: result.items?.length })
    return result
  }) as any
}
let ids = setup.ids
if (setup.phase === 'seed') {
  ids = await request('seed', setup.scene)
  const tab = createWorkbenchTab('reading-tab', { regionId: 'reading-region', kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: ids.sessionId })
  const layout = createWorkspaceLayout('reading-group', [tab.id])
  const snapshot = await api.sessions.snapshot()
  await api.spatial.commit({ expectedRevision: 0, graph: desktopSpatialGraph({ ...useAppStore.getState(), config: setup.config,
    tabs: { [tab.id]: tab }, layouts: { [workspace.id]: layout }, sessions: snapshot.sessions }, []) })
  const { name, version } = useAppStore.persist.getOptions()
  localStorage.setItem(name, JSON.stringify({ version, state: {
    restoredWorkbench: projectPersistedWorkbench({ tabs: { [tab.id]: tab }, layouts: { [workspace.id]: layout } }),
    activeWorkspaceId: workspace.id, mainSurface: 'workbench', toolsOpen: false, projectRailOpen: false,
    viewModes: { [ids.sessionId]: 'activity' }, agentComposerDrafts: { [ids.sessionId]: draft },
    ...(setup.scene === 'surfaces' ? { agentSteerQueues: { [ids.sessionId]: [{ operationId: 'surface-paused-intent', runId: ids.runId, text: surfacePending, status: 'queued', awaitingExplicitSend: true, promptCondition: null, origin: 'manual' }] } } : {})
  } }))
}
const metrics = { frames: [] as number[], longTasks: [] as number[], added: 0, removed: 0 }
let previousFrame: number | undefined
const frame = (now: number) => { if (previousFrame !== undefined) metrics.frames.push(now - previousFrame); previousFrame = now; requestAnimationFrame(frame) }
requestAnimationFrame(frame)
new PerformanceObserver(list => { metrics.longTasks.push(...list.getEntries().map(entry => entry.duration)) }).observe({ type: 'longtask', buffered: true })
new MutationObserver(changes => { for (const change of changes) { metrics.added += change.addedNodes.length; metrics.removed += change.removedNodes.length } if (changes.some(change => change.target instanceof Element && change.target.closest('.activity-feed'))) mark('dom-commit') }).observe(document.getElementById('root')!, { childList: true, subtree: true })
const feed = () => document.querySelector<HTMLElement>('[data-workbench-region-id="reading-region"] .activity-feed')
const rows = () => Array.from(feed()?.querySelectorAll<HTMLElement>('[data-conversation-layout-key], [data-message-source-key]') ?? [])
;(window as any).readingProof = {
  ids, reads, metrics, errors, events, mark,
  nativeCut() { return nativeCut },
  holdEarlier() { if (!olderCursor) throw new Error('No exact earlier page cursor'); held = { cursor: olderCursor, received: false } },
  heldEarlier() { return held?.received === true },
  releaseEarlier() { if (!held?.release) throw new Error('No original response to release'); released = { cursor: held.cursor }; mark('release-earlier-response'); held.release(); held = undefined },
  releasedEarlier() {
    if (!released?.returned) return null
    const result = inspectConversationConsumers({ hostId: 'local', agentSessionId: ids.sessionId, expectedRunId: ids.runId })
    const consumer = result.consumers.find(item => item.location.regionId === 'reading-region')
    const expected = released.returned
    const matches = (frame: typeof consumer.accepted) => frame?.id === expected.id && frame.revision >= expected.revision
    return consumer && !consumer.inFlight && !consumer.loading && (matches(consumer.accepted) || consumer.held && matches(consumer.pending)) ? { expected, consumer } : null
  },
  state() { const state = useAppStore.getState(); return { ...projectPersistedWorkbench(state), drafts: state.agentComposerDrafts, viewModes: state.viewModes, activeWorkspaceId: state.activeWorkspaceId, mainSurface: state.mainSurface } },
  inspect() { const node = feed(), rect = node?.getBoundingClientRect(); return { hasFeed: !!node, scrollTop: node?.scrollTop, scrollHeight: node?.scrollHeight, clientHeight: node?.clientHeight,
    rows: rows().map(row => ({ key: row.dataset.conversationLayoutKey ?? row.dataset.messageSourceKey, top: row.getBoundingClientRect().top, text: row.textContent?.slice(0, 80) })),
    firstVisible: rows().find(row => { const r = row.getBoundingClientRect(); return rect && r.bottom > rect.top && r.top < rect.bottom })?.dataset.messageSourceKey,
    allNodes: node?.querySelectorAll('*').length, bodyElements: node?.querySelectorAll('.log-turn__body:not(.conversation-progressive-body__placeholder), .conversation-markdown, .markdown-content').length,
    selection: window.getSelection()?.toString(), activeTag: document.activeElement?.tagName } },
  async flush() { prepareRendererUpdate(); await request('flush') }
}
createRoot(document.getElementById('root')!).render(<DesktopClientUiProvider><App /></DesktopClientUiProvider>)
