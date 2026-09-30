import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { createWorkspaceLayout } from '@agentmux/layout'
import { App } from '../../../src/renderer/src/App'
import { api } from '../../../src/renderer/src/lib/api'
import { prepareRendererUpdate, useAppStore } from '../../../src/renderer/src/store'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { readPmoTeamsTopicFloatingState } from '../../../src/renderer/src/lib/pmo-teams-topic-floating'
import { scratchTopicKind } from '../../../src/renderer/src/lib/scratch-topic-snapshots'
import { topicSpaceIconTarget } from '../../../src/renderer/src/lib/space-object-appearance'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../../../src/shared/scratch-topics'
import type { AppConfig } from '../../../src/shared/contracts'
import { customAgent, customMoteId, customTab, defaultAgent, executionAgent, moteSessions, moteTabs,
  ordinaryTopicId, quietMoteId, savedMoteKey } from '../../../test/fixtures/mote-workface'
import '../../../src/renderer/src/styles/index.css'

declare global {
  interface Window {
    moteArchiveNative: {
      bootstrap(): Promise<{ config: AppConfig; phase: 'seed' | 'restore' }>
      config(): Promise<AppConfig>; flushStorage(): Promise<void>
    } & Pick<typeof api.scratch, 'listTopics' | 'readTopic' | 'ensureMote' | 'setMoteArchived'>
    moteArchiveProof: typeof proof
  }
}
const bridge = window.moteArchiveNative
if (!bridge) throw new Error('The real private Scratch IPC bridge is required')
const boot = await bridge.bootstrap(), phase = boot.phase
const scratch = boot.config.workspaces.find(one => one.id === SCRATCH_WORKSPACE_ID)!
const project = boot.config.workspaces.find(one => one.id === 'project')!
const durableKey = 'agentmux-workbench-v1'
const initialDurable = JSON.parse(localStorage.getItem(durableKey) ?? 'null')
const initialFloating = JSON.parse(localStorage.getItem(savedMoteKey) ?? 'null')
if (phase === 'seed' && (initialDurable !== null || initialFloating !== null)) throw new Error('Seed requires a genuinely fresh private profile')
if (phase === 'restore' && (!initialDurable || !initialFloating)) throw new Error('Restore must read the first process original durable state')
const calls: { operation: string; detail?: unknown }[] = [], errors: string[] = [], events: unknown[] = []
const copy = <T,>(value: T): T => structuredClone(value)
const note = (operation: string, detail?: unknown) => { calls.push({ operation, detail }) }
window.addEventListener('error', event => errors.push(event.message))
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)))
const sessions = moteSessions.map(one => ({ ...one, workspacePath: one.workspacePath
  .replace(/^\/topics(?=\/|$)/, scratch.path).replace(/^\/project(?=\/|$)/, project.path) }))
const timelines: ReturnType<typeof useAppStore.getState>['timelines'] = Object.fromEntries(sessions.map(one => [one.id, {
  agentSessionId: one.id, revision: 1, items: [
    { id: 'request-' + one.id, agentSessionId: one.id, kind: 'user_message' as const, content: 'Keep the original context and unsent draft.',
      title: 'Original request', source: 'native-hook' as const, status: 'complete' as const, createdAt: 1000, updatedAt: 1000 },
    { id: 'reply-' + one.id, agentSessionId: one.id, kind: 'assistant_message' as const, content: 'I can continue this work while its Mote is archived.',
      title: 'Original response', source: 'native-hook' as const, status: 'complete' as const, createdAt: 2000, updatedAt: 2000 }
  ]
}]))
// The external Runtime is controlled. Filesystem archive facts and original App,
// store, ordinary initialization, durable writer, popovers and inputs are real.
api.config.get = bridge.config; api.config.onChange = () => () => {}
api.scratch.listTopics = bridge.listTopics; api.scratch.readTopic = bridge.readTopic
api.scratch.ensureMote = bridge.ensureMote; api.scratch.setMoteArchived = bridge.setMoteArchived
api.ui.requestStorageFlush = bridge.flushStorage
api.demands.list = async () => []
api.sessions.snapshot = async () => ({ sessions: copy(sessions), timelines: copy(timelines), recoveryCandidates: [] })
api.sessions.onEvent = () => () => {}
const sessionFor = (control: { agentSessionId: string; run: { runId: string } }) => sessions.find(one =>
  one.id === control.agentSessionId && one.control.run.runId === control.run.runId)
api.sessions.recover = async control => {
  if (control.kind !== 'agent') throw new Error('No terminal/Run recovery is claimed')
  const session = sessionFor(control); if (!session) throw new Error('Only the original private Session may recover')
  note('controlledRecover', control); return { kind: 'reattachable', session: copy(session) }
}
api.sessions.attach = async control => {
  if (control.kind !== 'agent') throw new Error('No real terminal/Run attachment is claimed')
  const session = sessionFor(control); if (!session) throw new Error('Original Session identity is required')
  note('controlledAttach', control)
  return { attachmentId: 'controlled-' + session.id, session: copy(session), currentSize: null,
    terminal: { type: 'unknown', reason: 'origin_unknown' }, resizeRevision: 0, replay: [], gap: null }
}
api.sessions.refreshAttachment = async control => api.sessions.attach(control)
api.sessions.refresh = async control => {
  if (control.kind !== 'agent') throw new Error('No terminal/Run refresh is claimed')
  const session = sessionFor(control); if (!session) throw new Error('Only original Session facts may be refreshed')
  return copy(session)
}
api.sessions.detach = async () => {}; api.sessions.replay = async () => ({ replay: [], gap: null })
api.sessions.resize = async (_attachment, cols, rows) => ({ cols, rows })
api.sessions.historyPage = async control => ({ agentSessionId: control.agentSessionId,
  source: { providerId: 'fixture', nativeSessionId: 'controlled-' + control.agentSessionId }, items: [], nextCursor: null })
for (const name of ['launchAgent', 'launchTerminal', 'stop', 'write', 'submitPrompt'] as const) {
  api.sessions[name] = async (...args: unknown[]) => { note(name, args); throw new Error('Archive must never ' + name) }
}
const dispose = await useAppStore.getState().initialize()
const afterOrdinaryInitialize = copy({ tabs: Object.keys(useAppStore.getState().tabs), drafts: useAppStore.getState().agentComposerDrafts,
  layouts: useAppStore.getState().layouts, focus: useAppStore.getState().agentFocus })
if (phase === 'seed') {
  const background = createWorkbenchTab('archive-original-project-tab', { regionId: 'archive-original-project-region',
    workspaceId: 'project', kind: 'agent', phase: 'attached', sessionId: executionAgent.id }, 'Original project work')
  const target = await api.scratch.readTopic(SCRATCH_WORKSPACE_ID, customMoteId)
  if (!target?.soul || target.moteArchive?.state !== 'active') throw new Error('Real nonempty custom Mote is required before seeding workfaces')
  useAppStore.setState({ tabs: { ...moteTabs, [background.id]: background },
    layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', Object.keys(moteTabs)),
      project: createWorkspaceLayout('archive-project-group', [background.id]) },
    activeWorkspaceId: 'project', mainSurface: 'workbench', projectRailOpen: false, toolsOpen: false,
    agentFocus: { execution: { sessionId: executionAgent.id, history: [{ sessionId: executionAgent.id, focusedAt: 123 }] }, pmo: { sessionId: defaultAgent.id } },
    viewModes: Object.fromEntries(sessions.map(one => [one.id, 'activity' as const])),
    spaceObjectIcons: { [topicSpaceIconTarget(scratch, target).key]: 'flask' },
    pinnedItems: { [SCRATCH_WORKSPACE_ID]: [customMoteId] }, scratchTopicOrder: [customMoteId, PMO_TEAMS_TOPIC_ID, quietMoteId],
    agentComposerDrafts: { [defaultAgent.id]: 'Default original unsent', [customAgent.id]: 'Archive keeps my original Analyst draft',
      [executionAgent.id]: 'Original project draft stays unsent', 'quiet-region': 'Original Launcher draft stays unsent' } })
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: false, targetTopicId: customMoteId, targetTabId: customTab.id, railMode: 'cards' }))
}
// App mounts its genuine tree; initialization has already completed exactly once.
// No restore branch writes tabs/layouts/drafts/viewModes/floating preferences.
useAppStore.setState({ initialize: async () => () => {},
  prewarmTerminal: (...args) => note('controlledWarm', args), detectExecutors: async () => { note('controlledDetect') },
  launchAgent: async (...args) => { note('launchAgent', args); throw new Error('Archive cannot launch') },
  send: (...args) => { note('send', args); return false }, enqueueAgentSteer: (...args) => { note('queue', args); return false } })
const tokens = new WeakMap<Element, number>(); let sequence = 0
const token = (node: Element | null) => { if (!node) return null; if (!tokens.has(node)) tokens.set(node, ++sequence); return tokens.get(node) }
const rectangle = (node: Element | null) => {
  if (!node) return null; const r = node.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }
}
function protectedFacts() {
  const state = useAppStore.getState(), persisted = projectPersistedWorkbench(state)
  const tabs = Object.fromEntries(Object.entries(persisted.tabs).map(([id, tab]) => [id, { ...tab,
    regions: Object.fromEntries(Object.entries(tab.regions).map(([id, surface]) => {
      const { phase: _phase, ...original } = surface as typeof surface & { phase?: unknown }; return [id, original]
    })) }]))
  return copy({ tabs, layouts: persisted.layouts, drafts: state.agentComposerDrafts, focus: state.agentFocus,
    outbox: state.agentSteerQueues, viewModes: state.viewModes, icons: state.spaceObjectIcons,
    pinned: state.pinnedItems, order: state.scratchTopicOrder, timelines: state.timelines,
    sessionFacts: state.sessions.map(one => ({ id: one.id, kind: one.kind, control: one.control,
      workspacePath: one.workspacePath, processState: one.processState, state: one.status.state })) })
}
function facts() {
  const panel = document.getElementById('pmo-teams-topic-floating-panel'), state = useAppStore.getState()
  const prompt = panel?.querySelector<HTMLTextAreaElement>('[aria-label="Message Agent"]') ?? null
  return { ready: !!document.querySelector('.app-shell') && !state.loading, phase, protected: protectedFacts(),
    calls: copy(calls), errors: [...errors], events: copy(events), snapshot: copy(state.scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]),
    floating: copy(readPmoTeamsTopicFloatingState()), saved: JSON.parse(localStorage.getItem(savedMoteKey) ?? 'null'),
    initialization: { ordinaryCalls: 1, seedApplied: phase === 'seed', initialDurable, initialFloating, afterOrdinaryInitialize },
    ui: { visible: panel?.matches(':popover-open') ?? false, topicId: panel?.dataset.moteTargetTopic,
      tabId: panel?.dataset.moteTargetTab, rail: panel?.dataset.moteNavigation, rect: rectangle(panel),
      choices: [...(panel?.querySelectorAll<HTMLElement>('[data-mote-topic-id]') ?? [])].map(node => node.dataset.moteTopicId),
      archivedNotice: panel?.querySelector('[data-mote-archived]')?.textContent ?? null,
      input: prompt ? { token: token(prompt), text: prompt.value ?? prompt.textContent, rect: rectangle(prompt) } : null,
      active: document.activeElement?.getAttribute('aria-label') ?? null, settings: !!document.querySelector('[data-settings-page]'),
      backgroundInert: document.querySelector<HTMLElement>('.app-shell__workspace')?.inert ?? null, panelInert: panel?.closest('[inert]') !== null, activeWorkspaceId: state.activeWorkspaceId } }
}
const root = createRoot(document.getElementById('root')!)
const proof = { ready: false, facts, ids: { primary: PMO_TEAMS_TOPIC_ID, custom: customMoteId, quiet: quietMoteId, ordinary: ordinaryTopicId },
  showSpaceNavigation: () => useAppStore.setState({ projectRailOpen: true }),
  refresh: () => useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID, true),
  readOriginal: async (id: string) => {
    const topic = await api.scratch.readTopic(SCRATCH_WORKSPACE_ID, id)
    return { topic, kind: scratchTopicKind(id, topic ? [topic] : []) }
  },
  flush: async () => {
    await prepareRendererUpdate(); const bytes = localStorage.getItem(durableKey)
    if (!bytes) throw new Error('Original durable writer has not published its record')
    return { serialized: bytes, floating: localStorage.getItem(savedMoteKey), facts: facts() }
  }, dispose: () => { root.unmount(); dispose(); proof.ready = false } }
for (const name of ['contextmenu', 'keydown', 'click', 'focusin']) document.addEventListener(name, event => {
  const node = event.target instanceof Element ? event.target : null
  events.push({ type: name, trusted: event.isTrusted, key: event instanceof KeyboardEvent ? event.key : null,
    label: node?.getAttribute('aria-label') ?? node?.textContent?.slice(0, 120) }); if (events.length > 120) events.shift()
}, true)
window.moteArchiveProof = proof
root.render(createElement(App))
requestAnimationFrame(() => requestAnimationFrame(() => { proof.ready = true }))
