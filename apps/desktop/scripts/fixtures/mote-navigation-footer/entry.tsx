import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { createWorkspaceLayout } from '@agentmux/layout'
import { App } from '../../../src/renderer/src/App'
import { api } from '../../../src/renderer/src/lib/api'
import { readPmoTeamsTopicFloatingState } from '../../../src/renderer/src/lib/pmo-teams-topic-floating'
import { prepareRendererUpdate, useAppStore } from '../../../src/renderer/src/store'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { rendererCssBoundsToWindowDip } from '../../../src/renderer/src/lib/browser-bounds-sync'
import type { AppConfig, ScratchTopicSnapshot } from '../../../src/shared/contracts'
import { APP_APPEARANCE_DATASET_KEY } from '../../../src/renderer/src/lib/theme-contract'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../../../src/shared/scratch-topics'
import { customAgent, customMoteId, customTab, defaultAgent, defaultTab, executionAgent,
  moteTopics, moteSessions, moteTabs, moteConfig, quietMoteId, savedMoteKey, seedMoteWorkface } from '../../../test/fixtures/mote-workface'
import '../../../src/renderer/src/styles/index.css'

type Store = ReturnType<typeof useAppStore.getState>
type Call = { operation: string; detail?: unknown }
const calls: Call[] = [], errors: string[] = [], events: unknown[] = []
const publications: Parameters<typeof api.ui.publishNativeOverlays>[0][] = []
declare global {
  interface Window {
    moteIdentityNative?: {
      bootstrap(): Promise<{ config: AppConfig; topics: ScratchTopicSnapshot[] }>
      config(): Promise<AppConfig>; requestStorageFlush(): Promise<void>
    } & Pick<typeof api.scratch, 'listTopics' | 'readTopic' | 'ensureMote' | 'previewMoteAvatar' | 'saveMoteAvatar' | 'readMoteAvatar'>
    moteFooterNative?: Partial<typeof api.ui>
    motePresentationReview: ReturnType<typeof presentationReview>
  }
}
window.addEventListener('error', event => errors.push(event.message))
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)))
const copy = <T,>(value: T): T => structuredClone(value)
const note = (operation: string, detail?: unknown): void => { calls.push({ operation, detail }) }
const identityBridge = window.moteIdentityNative
const identityBoot = identityBridge ? await identityBridge.bootstrap() : null
const identityFirst = Boolean(identityBridge && window.localStorage.getItem('agentmux-workbench-v1') === null)
const observedAt = Date.now()
const controlledSessions = moteSessions.map(session => ({ ...session,
  ...(identityBoot ? { workspacePath: session.workspacePath.replace(/^\/topics(?=\/|$)/, identityBoot.config.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID)!.path).replace(/^\/project(?=\/|$)/, identityBoot.config.workspaces.find(item => item.id === 'project')!.path) } : {}),
  status: { ...session.status, observedAt }, agentSessionUpdatedAt: observedAt }))

// Only external data/control boundaries. No component, style, popover or input
// event is mocked; native supplement may connect these original UI methods.
if (window.moteFooterNative) Object.assign(api.ui, window.moteFooterNative)
const publish = api.ui.publishNativeOverlays.bind(api.ui)
api.ui.publishNativeOverlays = async regions => {
  publications.push(copy(regions)); if (publications.length > 128) publications.shift()
  return publish(regions)
}
api.config.get = identityBridge ? identityBridge.config : async () => copy(useAppStore.getState().config ?? moteConfig)
api.config.onChange = () => () => {}
api.scratch.listTopics = identityBridge ? identityBridge.listTopics : async () => { note('directoryRead'); return copy(controlledTopics) }
api.scratch.ensureMote = identityBridge ? identityBridge.ensureMote : async (_workspaceId, id) => {
  note('ensureMote', id)
  const one = controlledTopics.find(topic => topic.id === id)
  if (!one || id !== PMO_TEAMS_TOPIC_ID && !one.soul) throw new Error('Controlled Mote is unavailable')
  return copy(one)
}
api.scratch.readTopic = identityBridge ? identityBridge.readTopic : async (_workspaceId, id) => copy(controlledTopics.find(topic => topic.id === id) ?? null)
api.sessions.onEvent = () => () => {}
api.sessions.snapshot = async () => ({ sessions: copy(controlledSessions), timelines: copy(useAppStore.getState().timelines), recoveryCandidates: [] })
api.sessions.historyPage = async control => {
  note('controlledHistoryRead', control.agentSessionId)
  return { agentSessionId: control.agentSessionId, source: {
    providerId: 'fixture', nativeSessionId: 'controlled-' + control.agentSessionId
  }, items: [], nextCursor: null }
}
api.sessions.attach = async control => {
  const one = control.kind === 'agent' ? controlledSessions.find(session => session.id === control.agentSessionId) : undefined
  if (!one) throw new Error('This Renderer fixture has no real terminal/Run attachment')
  note('controlledAttach', one.id)
  return { attachmentId: 'controlled-' + one.id, session: copy(one), currentSize: null,
    terminal: { type: 'unknown', reason: 'origin_unknown' }, resizeRevision: 0, replay: [], gap: null }
}
api.sessions.detach = async () => {}
api.sessions.replay = async () => ({ replay: [], gap: null })
api.sessions.resize = async (attachment, cols, rows) => { note('controlledResize', { attachment, cols, rows }); return { cols, rows } }
api.sessions.launchAgent = async input => { note('apiLaunch', input); throw new Error('No Agent may launch in this presentation fixture') }
api.sessions.launchTerminal = async input => { note('apiLaunchTerminal', input); throw new Error('No terminal may launch in this presentation fixture') }
api.sessions.stop = async input => { note('stop', input); throw new Error('No controlled original Session may stop') }
api.sessions.write = async input => { note('write', input); throw new Error('No input may be submitted') }
api.sessions.submitPrompt = async input => { note('submit', input); throw new Error('No prompt may be submitted') }

if (identityBridge) {
  api.scratch.previewMoteAvatar = identityBridge.previewMoteAvatar
  api.scratch.saveMoteAvatar = identityBridge.saveMoteAvatar
  api.scratch.readMoteAvatar = identityBridge.readMoteAvatar
  api.ui.requestStorageFlush = identityBridge.requestStorageFlush
}
if (!identityBridge) seedMoteWorkface()
let controlledTopics = copy(identityBoot?.topics ?? moteTopics)
const backgroundId = 'presentation-original-project-tab'
const originalTab = createWorkbenchTab(backgroundId, { regionId: 'presentation-original-project-region',
  workspaceId: 'project', kind: 'agent', phase: 'attached', sessionId: executionAgent.id }, 'Original work remains available')
const timelines: Store['timelines'] = {}
for (const [session, request, reply] of [
  [defaultAgent, 'Help me keep a clear next step.', 'I am checking the current work. The same target and your draft stay here.'],
  [customAgent, 'Review the next small change.', 'I can review this context while the original work continues.'],
  [executionAgent, 'Keep the original work surface available.', 'This original work surface and its input remain in place.']
] as const) {
  timelines[session.id] = { agentSessionId: session.id, revision: 1, items: [
    { id: 'request-' + session.id, agentSessionId: session.id, kind: 'user_message', content: request,
      title: request, source: 'native-hook', status: 'complete', createdAt: 1000, updatedAt: 1000 },
    { id: 'reply-' + session.id, agentSessionId: session.id, kind: 'assistant_message', content: reply,
      title: reply, source: 'native-hook', status: 'complete', createdAt: 2000, updatedAt: 2000 }
  ] }
}
// App owns the actual workbench and Composer. Initialization would ask unrelated
// external services to replace these typed controlled facts, so it is a no-op.
if (!identityBridge) useAppStore.setState((current): Partial<Store> => ({
  loading: false,
  sessions: controlledSessions,
  config: { ...moteConfig, appearance: { ...moteConfig.appearance, appAppearance: 'dark' } },
  tabs: { ...current.tabs, [originalTab.id]: originalTab },
  layouts: { ...current.layouts, project: createWorkspaceLayout('presentation-project-group', [originalTab.id]) },
  activeWorkspaceId: 'project', mainSurface: 'workbench', timelines,
  viewModes: { [defaultAgent.id]: 'activity', [customAgent.id]: 'activity', [executionAgent.id]: 'activity' },
  initialize: async () => () => {},
  prewarmTerminal: (...args) => note('warm', args),
  detectExecutors: async () => { note('detect') },
  launchAgent: async (...args) => { note('launch', args) },
  send: (...args) => { note('send', args); return false },
  enqueueAgentSteer: (...args) => { note('queue', args); return false },
  reportError: error => { errors.push(String(error)) }
}))
if (identityBridge) {
  const ordinaryInitialize = useAppStore.getState().initialize
  useAppStore.setState({
    initialize: async () => {
      const dispose = await ordinaryInitialize()
      useAppStore.setState(current => ({
        timelines,
        viewModes: { [defaultAgent.id]: 'activity', [customAgent.id]: 'activity', [executionAgent.id]: 'activity' },
        agentComposerDrafts: { [defaultAgent.id]: 'Default unsent', [customAgent.id]: 'Analyst unsent', [executionAgent.id]: 'Execution unsent' },
        ...(identityFirst ? {
          tabs: { ...moteTabs, [originalTab.id]: originalTab },
          layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', Object.keys(moteTabs)), project: createWorkspaceLayout('presentation-project-group', [originalTab.id]) },
          activeWorkspaceId: 'project', mainSurface: 'workbench' as const, projectRailOpen: false,
          agentFocus: { execution: { sessionId: executionAgent.id, history: [{ sessionId: executionAgent.id, focusedAt: 123 }] }, pmo: { sessionId: defaultAgent.id } }
        } : {})
      }))
      return dispose
    },
    prewarmTerminal: (...args) => note('warm', args), detectExecutors: async () => { note('detect') },
    launchAgent: async (...args) => { note('launch', args) }, send: (...args) => { note('send', args); return false },
    enqueueAgentSteer: (...args) => { note('queue', args); return false }
  })
}
// Seed once only. Reload must consume the real floating owner's saved preferences.
if (window.localStorage.getItem(savedMoteKey) === null)
  window.localStorage.setItem(savedMoteKey, JSON.stringify({ open: false, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id }))
let failPreferenceSave = false
const storageSetItem = Storage.prototype.setItem
Storage.prototype.setItem = function (key: string, value: string) {
  if (key === savedMoteKey) {
    note('preferenceSave', { failed: failPreferenceSave })
    if (failPreferenceSave) throw new DOMException('Controlled storage unavailable', 'SecurityError')
  }
  return storageSetItem.call(this, key, value)
}

const rect = (node: Element | null | undefined) => {
  if (!node) return null
  const r = node.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }
}
const tokens = new WeakMap<Element, number>(); let nextToken = 1
const token = (node: Element | null | undefined) => {
  if (!node) return null
  if (!tokens.has(node)) tokens.set(node, nextToken++)
  return tokens.get(node)
}
const inputFacts = (node: HTMLElement | null) => {
  if (!node) return null
  const input = node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? node : null
  const selection = window.getSelection()
  return { token: token(node), label: node.getAttribute('aria-label'), editable: node.isContentEditable,
    text: input ? input.value : node.textContent, rect: rect(node),
    start: input?.selectionStart, end: input?.selectionEnd,
    selection: selection ? { anchor: selection.anchorOffset, focus: selection.focusOffset,
      anchorText: selection.anchorNode?.textContent, focusText: selection.focusNode?.textContent } : null }
}
const panel = () => document.querySelector<HTMLElement>('[data-pmo-teams-topic-floating]')
const entry = () => document.querySelector<HTMLButtonElement>('[data-pmo-teams-topic-launcher] button')
const prompt = (scope: Element | null) => scope?.querySelector<HTMLElement>('[aria-label="Message Agent"]') ?? null
function protectedFacts() {
  const current = useAppStore.getState()
  return copy({ execution: current.agentFocus.execution, viewModes: current.viewModes,
    drafts: current.agentComposerDrafts, outbox: current.agentSteerQueues,
    tabs: current.tabs, layouts: current.layouts, mainSurface: current.mainSurface,
    activeWorkspaceId: current.activeWorkspaceId })
}
function facts() {
  const floating = panel(), launcher = entry(), active = document.activeElement
  const paintNodes = launcher?.querySelectorAll<HTMLElement>('.pmo-teams-topic-compact-launcher__surface[data-state="open"]')
  const paint = paintNodes?.length === 1 ? paintNodes[0] : null
  const zoomFactor = api.ui.getZoomFactor()
  const nativeBounds = paint ? rendererCssBoundsToWindowDip(paint.getBoundingClientRect(), zoomFactor) : null
  const latestRegions = publications.at(-1) ?? []
  const paintedRegions = nativeBounds ? latestRegions.filter(region =>
    Object.entries(nativeBounds).every(([key, value]) => region.bounds[key as keyof typeof nativeBounds] === value)) : []
  const footer = document.querySelector<HTMLElement>('.window-status-bar')
  const choices = [...(floating?.querySelectorAll<HTMLButtonElement>('[data-mote-topic-id]') ?? [])]
  const identity = floating?.querySelector<HTMLElement>('.mote-chooser__identity[role="tooltip"]')
  return {
    ready: document.querySelector('.app-shell') !== null && !useAppStore.getState().loading, identity: { choices: copy(useAppStore.getState().spaceObjectIcons), workbenchWarning: useAppStore.getState().workbenchSaveWarning, error: useAppStore.getState().error, snapshot: copy(useAppStore.getState().scratchTopicSnapshots), entryAvatar: launcher?.querySelector<HTMLImageElement>('img')?.src ?? null }, protected: protectedFacts(), calls: copy(calls), errors: [...errors],
    saved: JSON.parse(localStorage.getItem(savedMoteKey) ?? 'null'), floating: copy(readPmoTeamsTopicFloatingState()),
    ui: { appearance: document.documentElement.dataset[APP_APPEARANCE_DATASET_KEY],
      visible: floating?.matches(':popover-open') ?? false, presentation: floating?.dataset.motePresentation,
      rail: floating?.dataset.moteNavigation, topicId: floating?.dataset.moteTargetTopic,
      resizing: floating?.dataset.moteResizing, resizeRect: rect(floating?.querySelector('[aria-label="Resize Mote window"]')),
      bodyStyles: { cursor: document.body.style.cursor, userSelect: document.body.style.userSelect },
      preferenceNotice: floating?.querySelector('.mote-size-notice')?.textContent ?? null,
      workfaceControls: [...(floating?.querySelectorAll<HTMLElement>('.pmo-teams-topic-floating__content button, .pmo-teams-topic-floating__content [aria-label="Message Agent"]') ?? [])]
        .filter(node => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0)
        .map(node => ({ label: node.getAttribute('aria-label') ?? node.textContent, rect: rect(node) })),
      tabId: floating?.dataset.moteTargetTab, sessionId: floating?.dataset.moteTargetSession,
      state: floating?.dataset.moteStatus, panelRect: rect(floating), footerRect: rect(footer),
      entryRect: rect(launcher), entryWrapperRect: rect(launcher?.closest('[data-pmo-teams-topic-launcher]')),
      entryPaintRect: rect(paint), entryPaintNodeCount: paintNodes?.length ?? 0,
      entryCollector: { windowBounds: nativeBounds, zoomFactor, matchingRegions: copy(paintedRegions),
        invokerBackground: launcher ? getComputedStyle(launcher).backgroundColor : null,
        invokerRadius: launcher ? getComputedStyle(launcher).borderRadius : null },
      railRect: rect(floating?.querySelector('.mote-chooser')), bodyRect: rect(floating?.querySelector('.pmo-teams-topic-floating__content')),
      panelPaint: floating ? { border: getComputedStyle(floating).border, shadow: getComputedStyle(floating).boxShadow,
        background: getComputedStyle(floating).backgroundColor } : null,
      entryPaint: launcher && paint ? { radius: getComputedStyle(paint).borderRadius,
        background: getComputedStyle(paint).backgroundColor, opacity: getComputedStyle(paint).opacity,
        pointerEvents: getComputedStyle(paint).pointerEvents, dataState: paint.getAttribute('data-state'),
        paintedOutline: getComputedStyle(paint).outline,
        outline: getComputedStyle(launcher).outline, outlineOffset: getComputedStyle(launcher).outlineOffset,
        focusVisible: launcher.matches(':focus-visible') } : null,
      avatarRect: rect(launcher?.querySelector('img')), statusRect: rect(launcher?.querySelector('.pmo-teams-topic-compact-launcher__status')),
      ordinarySlots: [...document.querySelectorAll<HTMLElement>('.surface-navigation__slot--surface, .surface-navigation__settings, .window-status-bar__right .agent-status-bar__segment--action, .window-status-bar__right .global-system-notices__trigger, .window-status-bar__utility-button')]
        .map(node => ({ label: node.getAttribute('aria-label'), owner: node.className, rect: rect(node) })),
      choices: choices.map(node => ({ id: node.dataset.moteTopicId, selected: node.getAttribute('aria-pressed'),
        name: node.getAttribute('aria-label'), status: node.dataset.moteStatus, rect: rect(node) })),
      identityTip: identity ? { text: identity.textContent, rect: rect(identity) } : null,
      actions: [...(floating?.querySelectorAll<HTMLButtonElement>('.mote-chooser__actions button') ?? [])]
        .map(node => ({ label: node.getAttribute('aria-label'), rect: rect(node) })),
      panelInert: Boolean(floating?.closest('[inert], [aria-hidden="true"]')),
      backgroundInert: document.querySelector('.app-shell__workspace')?.hasAttribute('inert'),
      settings: Boolean(document.querySelector('[data-settings-page]')),
      input: inputFacts(prompt(floating)), active: inputFacts(active instanceof HTMLElement ? active : null),
      titleRows: floating?.querySelectorAll('.pmo-teams-topic-floating__titlebar').length ?? 0,
      globalChrome: floating?.querySelectorAll('.top-row-leading-chrome').length ?? 0,
      railControl: floating?.querySelector('[aria-label="Show Mote avatars only"]')?.getAttribute('aria-pressed')
    }
  }
}
function presentationReview() {
  return { ready: false, backgroundId, defaultTabId: defaultTab.id, customTabId: customTab.id,
    defaultMoteId: PMO_TEAMS_TOPIC_ID, customMoteId, quietMoteId,
    moteIds: [PMO_TEAMS_TOPIC_ID, customMoteId, quietMoteId], facts,
    events: () => copy(events), publications: () => copy(publications),
    fullSpace: () => useAppStore.setState({ projectRailOpen: true }),
    flushIdentity: () => prepareRendererUpdate(),
    preferenceSaveFailure: (fail: boolean) => { failPreferenceSave = fail },
    footerCounts: (working: number, attention: number) => {
      const originals = controlledSessions.map(session => ({ ...session, status: { ...session.status, state: 'idle' as const } }))
      const counted = (count: number, state: 'working' | 'error') => Array.from({ length: count }, (_, index) => {
        const id = `footer-${state}-${index}`
        return { ...executionAgent, id, label: id, status: { ...executionAgent.status, state, observedAt },
          control: { ...executionAgent.control, agentSessionId: id, run: { runId: `controlled-${id}` } } }
      })
      useAppStore.setState({ sessions: [...originals, ...counted(working, 'working'), ...counted(attention, 'error')] })
    },
    longNames: () => {
      controlledTopics = controlledTopics.map(topic => topic.id === customMoteId
        ? { ...topic, title: 'Planning and reviewing every small next step with the original context and unsent draft' } : topic)
      useAppStore.setState(current => ({
        tabs: { ...current.tabs, [defaultTab.id]: { ...current.tabs[defaultTab.id]!, name: 'Keep every original target, split region and unsent input visible while reviewing a long goal title' } },
        scratchTopicSnapshots: { ...current.scratchTopicSnapshots, [SCRATCH_WORKSPACE_ID]: {
          ...current.scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!, topics: controlledTopics
        } }
      }))
    },
    theme: (mode: 'dark' | 'light') => useAppStore.setState(current => ({
      config: { ...current.config!, appearance: { ...current.config!.appearance, appAppearance: mode } }
    })),
    focusBackground: () => {
      const input = document.querySelector<HTMLElement>(`[data-workbench-tab-id="${backgroundId}"] [aria-label="Message Agent"]`)
      if (!input) throw new Error('Actual original project Composer is missing')
      input.focus()
      return inputFacts(input)
    },
    dispose: () => { root.unmount(); window.motePresentationReview.ready = false }
  }
}
for (const type of ['pointerenter', 'pointerleave', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture', 'click', 'focusin', 'keydown', 'toggle']) {
  document.addEventListener(type, event => {
    const target = event.target instanceof Element ? event.target : null
    if (!target?.closest('[data-pmo-teams-topic-launcher], [data-pmo-teams-topic-floating], [data-settings-page], .space-icon-picker, [role="menu"]')) return
    const keyboard = event instanceof KeyboardEvent ? event : null
    events.push({ type, trusted: event.isTrusted, label: target.getAttribute('aria-label'),
      key: keyboard?.key, composing: keyboard?.isComposing,
      presentation: panel()?.dataset.motePresentation, rail: panel()?.dataset.moteNavigation })
    if (events.length > 256) events.shift()
  }, true)
}
window.motePresentationReview = presentationReview()
const root = createRoot(document.getElementById('root')!)
root.render(createElement(App))
requestAnimationFrame(() => requestAnimationFrame(() => { window.motePresentationReview.ready = true }))
