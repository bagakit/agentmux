import { createElement, Profiler } from 'react'
import { createRoot } from 'react-dom/client'
import { createWorkspaceLayout } from '@agentmux/layout'
import { agentDisplayState } from '@agentmux/core/agent-status'
import { App } from '../../../src/renderer/src/App'
import { api } from '../../../src/renderer/src/lib/api'
import { createRendererSessionEvents } from '../../../src/renderer/src/lib/session-events'
import { prepareRendererUpdate, useAppStore } from '../../../src/renderer/src/store'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { readPmoTeamsTopicFloatingState } from '../../../src/renderer/src/lib/pmo-teams-topic-floating'
import { topicSpaceIconTarget } from '../../../src/renderer/src/lib/space-object-appearance'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../../../src/shared/scratch-topics'
import type { AppConfig, RuntimeEvent } from '../../../src/shared/contracts'
import type { MoteAvatarRef } from '../../../src/shared/mote-avatars'
import { customAgent, customMoteId, defaultAgent, defaultTab, executionAgent, moteSessions, moteTabs, quietMoteId, quietTab, savedMoteKey } from '../../../test/fixtures/mote-workface'
import '../../../src/renderer/src/styles/index.css'

declare global {
  interface Window {
    motePaperdollNative: { bootstrap(): Promise<{ config: AppConfig; phase: 'seed' | 'restore'; image: MoteAvatarRef }>; config(): Promise<AppConfig>; flushStorage(): Promise<void> } &
      Pick<typeof api.scratch, 'listTopics' | 'readTopic' | 'ensureMote' | 'readMoteAvatar' | 'previewMoteAvatar' | 'saveMoteAvatar'>
    motePaperdollProof: typeof proof
    moteFaceCosts: { commits: number; seen: Record<string, number>; renders: Record<string, number>; currentCommit: { start: number; end: number } | null }
  }
}
const bridge = window.motePaperdollNative ?? (location.protocol.startsWith('http') ? (await import('./paperdoll-browser')).browserPaperdollBridge : null)
if (!bridge) throw new Error('The real private Scratch IPC bridge is required')
const boot = await bridge.bootstrap(), phase = boot.phase, now = Date.now()
const scratch = boot.config.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID)!, project = boot.config.workspaces.find(item => item.id === 'project')!
const durableKey = 'agentmux-workbench-v1'
const initialDurable = JSON.parse(localStorage.getItem(durableKey) ?? 'null'), initialFloating = JSON.parse(localStorage.getItem(savedMoteKey) ?? 'null')
if (phase === 'seed' && (initialDurable !== null || initialFloating !== null)) throw new Error('Seed needs a fresh private profile')
if (phase === 'restore' && (!initialDurable || !initialFloating)) throw new Error('Restore must read the first process durable state')
const calls: { operation: string; detail?: unknown }[] = [], errors: string[] = [], transported: RuntimeEvent[] = []
const copy = <T,>(value: T): T => structuredClone(value)
const note = (operation: string, detail?: unknown) => calls.push({ operation, detail })
window.addEventListener('error', event => errors.push(event.message)); window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)))
const sessions = moteSessions.map(one => ({ ...one, workspacePath: one.workspacePath.replace(/^\/topics(?=\/|$)/, scratch.path).replace(/^\/project(?=\/|$)/, project.path),
  status: { ...one.status, observedAt: now }, semanticStatus: { state: one.status.state === 'waiting' ? 'waiting' as const : 'working' as const, source: 'native-hook' as const, observedAt: now, stateEnteredAt: now } }))
const timelines = Object.fromEntries(sessions.map(one => [one.id, { agentSessionId: one.id, revision: 1, items: [
  { id: 'request-' + one.id, agentSessionId: one.id, kind: 'user_message' as const, content: 'Keep my original work and unsent draft.', title: 'Original request', source: 'native-hook' as const, status: 'complete' as const, createdAt: 1, updatedAt: 1 },
  { id: 'reply-' + one.id, agentSessionId: one.id, kind: 'assistant_message' as const, content: 'The saved face belongs to this original Mote.', title: 'Original response', source: 'native-hook' as const, status: 'complete' as const, createdAt: 2, updatedAt: 2 }
] }]))
api.config.get = bridge.config; api.config.onChange = () => () => {}
api.scratch.listTopics = bridge.listTopics; api.scratch.readTopic = bridge.readTopic; api.scratch.ensureMote = bridge.ensureMote
api.scratch.readMoteAvatar = bridge.readMoteAvatar; api.scratch.previewMoteAvatar = bridge.previewMoteAvatar; api.scratch.saveMoteAvatar = bridge.saveMoteAvatar
api.ui.requestStorageFlush = bridge.flushStorage; api.demands.list = async () => []
api.sessions.snapshot = async () => ({ sessions: copy(sessions), timelines: copy(timelines), recoveryCandidates: [] })
let dispatch: ((event: RuntimeEvent) => void) | undefined, bridgeSubscriptions = 0
api.sessions.onEvent = createRendererSessionEvents(listener => { bridgeSubscriptions++; dispatch = listener; return () => { dispatch = undefined } })
const original = (control: { agentSessionId: string; run: { runId: string } }) => sessions.find(one => one.id === control.agentSessionId && one.control.run.runId === control.run.runId)
api.sessions.recover = async control => {
  if (control.kind !== 'agent') throw new Error('No real Run recovery is claimed')
  const session = original(control); if (!session) throw new Error('Only an original Session may recover')
  note('controlledRecover', control); return { kind: 'reattachable', session: copy(session) }
}
api.sessions.attach = async control => {
  if (control.kind !== 'agent') throw new Error('No real attachment is claimed')
  const session = original(control); if (!session) throw new Error('Original control is required')
  note('controlledAttach', control)
  return { attachmentId: 'controlled-' + session.id, session: copy(session), currentSize: null, terminal: { type: 'unknown', reason: 'origin_unknown' }, resizeRevision: 0, replay: [], gap: null }
}
api.sessions.refreshAttachment = control => api.sessions.attach(control)
api.sessions.refresh = async control => { if (control.kind !== 'agent') throw new Error('No real Run refresh'); const session = original(control); if (!session) throw new Error('Unknown original'); return copy(session) }
api.sessions.detach = async () => {}; api.sessions.replay = async () => ({ replay: [], gap: null })
api.sessions.resize = async (_attachment, cols, rows) => { note('resize', { cols, rows }); return { cols, rows } }
api.sessions.historyPage = async control => ({ agentSessionId: control.agentSessionId, source: { providerId: 'fixture', nativeSessionId: 'controlled-' + control.agentSessionId }, items: [], nextCursor: null })
for (const name of ['launchAgent', 'launchTerminal', 'stop', 'write', 'submitPrompt'] as const) api.sessions[name] = async (...args: unknown[]) => { note(name, args); throw new Error('Avatar cannot ' + name) }
const dispose = await useAppStore.getState().initialize()
const afterOrdinaryInitialize = copy({ tabs: Object.keys(useAppStore.getState().tabs), drafts: useAppStore.getState().agentComposerDrafts, layouts: useAppStore.getState().layouts, icons: useAppStore.getState().spaceObjectIcons })
if (phase === 'seed') {
  const target = await api.scratch.readTopic(SCRATCH_WORKSPACE_ID, customMoteId)
  if (!target?.soul) throw new Error('A real nonempty custom Mote is required')
  const background = createWorkbenchTab('face-original-project-tab', { regionId: 'face-original-project-region', workspaceId: 'project', kind: 'agent', phase: 'attached', sessionId: executionAgent.id }, 'Original project work')
  useAppStore.setState({ tabs: { ...moteTabs, [background.id]: background }, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', Object.keys(moteTabs)), project: createWorkspaceLayout('face-project-group', [background.id]) },
    activeWorkspaceId: 'project', mainSurface: 'workbench', projectRailOpen: false, toolsOpen: false,
    agentFocus: { execution: { sessionId: executionAgent.id, history: [{ sessionId: executionAgent.id, focusedAt: 123 }] }, pmo: { sessionId: defaultAgent.id } },
    viewModes: Object.fromEntries(sessions.map(one => [one.id, 'activity' as const])), spaceObjectIcons: { [topicSpaceIconTarget(scratch, target).key]: boot.image },
    agentComposerDrafts: { [defaultAgent.id]: 'Primary original draft remains unsent', [customAgent.id]: 'Custom original draft remains unsent', [executionAgent.id]: 'Project original draft remains unsent', 'quiet-region': 'Sleeping launcher draft remains unsent' } })
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: false, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id, railMode: 'cards' }))
}
useAppStore.setState({ initialize: async () => () => {}, prewarmTerminal: (...args) => note('controlledWarm', args), detectExecutors: async () => { note('controlledDetect') },
  launchAgent: async (...args) => { note('launchAgent', args); throw new Error('Avatar cannot launch') }, send: (...args) => { note('send', args); return false }, enqueueAgentSteer: (...args) => { note('queue', args); return false } })
function publish(event: RuntimeEvent) { if (!dispatch) throw new Error('The original single event bridge is absent'); transported.push(copy(event)); dispatch(copy(event)) }
function status(state: 'working' | 'done' | 'waiting' | 'error' | 'unknown') {
  const session = useAppStore.getState().sessions.find(one => one.id === defaultAgent.id)!
  const observedAt = Math.max(Date.now(), session.updatedAt + 1)
  publish({ type: 'core', hostId: session.hostId, event: { type: 'agent-session', session: { kind: 'agent', agentSessionId: session.id, providerId: 'fixture', executorId: 'fixture', hostId: session.hostId, workspacePath: session.workspacePath,
    run: session.control.run, retiredRuns: [], createdAt: 1, updatedAt: observedAt, semanticStatus: { state: agentDisplayState(state), source: 'native-hook', observedAt, stateEnteredAt: observedAt } } } })
  return observedAt
}
function timeline(id: string, mode: 'start' | 'complete' | 'failed' | 'history', options: { sessionId?: string; runId?: string; createdAt?: number; omitRun?: boolean } = {}) {
  const sessionId = options.sessionId ?? defaultAgent.id, store = useAppStore.getState(), session = store.sessions.find(one => one.id === sessionId)!
  const observedAt = Math.max(Date.now(), session.updatedAt + 1), createdAt = options.createdAt ?? observedAt
  const item = { id, agentSessionId: sessionId, kind: mode === 'history' ? 'assistant_message' as const : 'tool_call' as const, status: mode === 'start' ? 'streaming' as const : mode === 'failed' ? 'failed' as const : 'complete' as const,
    source: 'native-hook' as const, createdAt, updatedAt: observedAt, title: mode === 'history' ? 'Current history observation' : 'Read project notes', toolName: 'read', content: 'Bounded private typed event' }
  publish({ type: 'core', hostId: session.hostId, event: { type: 'agent-timeline', agentSessionId: sessionId, revision: (store.timelines[sessionId]?.revision ?? 0) + 1, mutation: { type: 'upsert', agentSessionId: sessionId, item },
    evidence: { source: 'native-hook', observedAt, ...(options.omitRun ? {} : { run: { runId: options.runId ?? session.control.run.runId } }) } } })
  return { observedAt, createdAt }
}
const rectangle = (node: Element | null) => { if (!node) return null; const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom } }
function protectedFacts() {
  const state = useAppStore.getState(), persisted = projectPersistedWorkbench(state)
  const tabs = Object.fromEntries(Object.entries(persisted.tabs).map(([id, tab]) => [id, { ...tab, regions: Object.fromEntries(Object.entries(tab.regions).map(([id, surface]) => { const { phase: _phase, ...original } = surface as typeof surface & { phase?: unknown }; return [id, original] })) }]))
  return copy({ tabs, layouts: persisted.layouts, drafts: state.agentComposerDrafts, execution: state.agentFocus.execution, queues: state.agentSteerQueues, modes: state.viewModes,
    controls: state.sessions.map(one => ({ id: one.id, control: one.control, workspacePath: one.workspacePath })) })
}
function animationFacts(node: Element) {
  return { expression: node.getAttribute('data-mote-expression'), motion: node.getAttribute('data-mote-motion'), rect: rectangle(node),
    animations: node.getAnimations({ subtree: true }).map(animation => ({ state: animation.playState, time: animation.currentTime, name: 'animationName' in animation ? String(animation.animationName) : null })),
    follow: node.querySelector('.mote-face__gaze-follow') ? getComputedStyle(node.querySelector('.mote-face__gaze-follow')!).transform : null,
    gaze: node.querySelector('.mote-face__gaze') ? getComputedStyle(node.querySelector('.mote-face__gaze')!).transform : null }
}
function editorFacts() {
  const dialog = document.querySelector('.space-icon-picker')
  if (!dialog) return null
  const groups = [...dialog.querySelectorAll('.mote-avatar-source, .mote-face-editor:not([hidden]) fieldset')].map(group => ({
    label: group.getAttribute('aria-label') ?? group.querySelector('legend')?.textContent,
    buttons: [...group.querySelectorAll('button')].map(button => {
      const style = getComputedStyle(button)
      return { label: button.getAttribute('aria-label') ?? button.textContent, selected: button.getAttribute('aria-pressed') === 'true', rect: rectangle(button), shadow: style.boxShadow,
        marks: [...button.querySelectorAll('.mote-avatar-selection-mark')].map(mark => { const style = getComputedStyle(mark); return { rect: rectangle(mark), visibility: style.visibility, display: style.display, opacity: style.opacity, paths: mark.querySelectorAll('path').length } }) }
    })
  }))
  const save = dialog.querySelector('.space-icon-picker__save'), cancel = dialog.querySelector('footer button')
  return { groups, save: save ? { primary: save.classList.contains('primary-button'), rect: rectangle(save), background: getComputedStyle(save).backgroundImage } : null,
    cancel: cancel ? { primary: cancel.classList.contains('primary-button'), rect: rectangle(cancel) } : null }
}
function facts() {
  const panel = document.getElementById('pmo-teams-topic-floating-panel'), state = useAppStore.getState(), entry = document.querySelector('[data-pmo-teams-topic-launcher] button')
  return { ready: !!document.querySelector('.app-shell') && !state.loading, phase, protected: protectedFacts(), icons: copy(state.spaceObjectIcons), calls: copy(calls), errors: [...errors], transported: copy(transported), bridgeSubscriptions,
    costs: copy(window.moteFaceCosts), floating: copy(readPmoTeamsTopicFloatingState()), saved: JSON.parse(localStorage.getItem(savedMoteKey) ?? 'null'), initialization: { initialDurable, initialFloating, afterOrdinaryInitialize, seeded: phase === 'seed' },
    ui: { topicId: entry?.getAttribute('data-mote-target-topic'), tabId: entry?.getAttribute('data-mote-target-tab'), sessionId: entry?.getAttribute('data-mote-target-session'), visible: panel?.matches(':popover-open'), rect: rectangle(panel),
      entry: entry ? { rect: rectangle(entry), image: entry.querySelector('img')?.getAttribute('src'), source: entry.querySelector('[data-space-icon-source]')?.getAttribute('data-space-icon-source'), motion: animationFacts(entry.querySelector('[data-mote-expression]')!) } : null,
      faces: [...document.querySelectorAll<HTMLElement>('[data-mote-expression]')].map(animationFacts), dialog: document.querySelector('.space-icon-picker')?.textContent ?? null, editor: editorFacts(), prompt: panel?.querySelector<HTMLTextAreaElement>('[aria-label="Message Agent"]')?.value ?? null } }
}
const root = createRoot(document.getElementById('root')!)
const proof = { ready: false, facts, status, timeline, protectedFacts, ids: { primary: PMO_TEAMS_TOPIC_ID, custom: customMoteId, quiet: quietMoteId },
  exactRestoring: () => useAppStore.setState(state => ({ sessions: state.sessions.filter(one => one.id !== defaultAgent.id) })),
  showSpaceNavigation: () => useAppStore.setState({ projectRailOpen: true }),
  flush: async () => { await prepareRendererUpdate(); const serialized = localStorage.getItem(durableKey); if (!serialized) throw new Error('Original durable writer is absent'); return { serialized, floating: localStorage.getItem(savedMoteKey), facts: facts() } },
  dispose: () => { root.unmount(); dispose(); proof.ready = false } }
window.motePaperdollProof = proof
root.render(createElement(Profiler, { id: 'actual-product-app', onRender: (_id, _phase, _duration, _baseDuration, start, end) => { window.moteFaceCosts.currentCommit = { start, end } } }, createElement(App)))
requestAnimationFrame(() => requestAnimationFrame(() => { proof.ready = true }))
