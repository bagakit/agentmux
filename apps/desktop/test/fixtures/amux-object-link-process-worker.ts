import { readFile, writeFile } from 'node:fs/promises'
import { deepStrictEqual } from 'node:assert/strict'
import { Window } from 'happy-dom'

// Browser and IPC boundaries only. Both processes load the real renderer owners
// after installing their browser storage, and share the real Core document.
const [phase, spatialPath, storagePath, mode = 'agent'] = process.argv.slice(2)
const moteMode = mode !== 'agent'
const stages: string[] = []
const stage = (name: string) => { stages.push(name); process.stderr.write('process-restore:' + mode + ':' + phase + ':' + name + '\n') }
stage('environment')
const browser = new Window({ url: 'http://navigation-restore.test' })
// A real desktop shell owns the event loop; this Node worker retains it while its browser/Store flushes settle.
const shellLease = setInterval(() => {}, 1000)
for (const [key, value] of Object.entries({
  self: browser, window: browser, document: browser.document, navigator: browser.navigator,
  CSS: browser.CSS, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser)
})) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
if (moteMode) {
  for (const key of ['Event', 'CustomEvent', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'InputEvent', 'Document', 'DocumentFragment', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLCanvasElement', 'HTMLImageElement', 'MutationObserver', 'ResizeObserver', 'DOMException', 'DOMRect', 'NodeFilter', 'Range', 'CSS', 'ShadowRoot']) {
    const value = (browser as unknown as Record<string, unknown>)[key]
    if (value !== undefined) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  Object.defineProperty(globalThis, 'matchMedia', { value: browser.matchMedia.bind(browser), configurable: true })
  Object.defineProperty(browser.Element.prototype, 'moveBefore', { configurable: true, value(this: Element, node: Node, before: Node | null) {
    if (node.ownerDocument !== this.ownerDocument) throw new browser.DOMException('The node belongs to another document.', 'WrongDocumentError')
    this.insertBefore(node, before)
  } })
  Object.defineProperty(globalThis, 'getComputedStyle', { value: browser.getComputedStyle.bind(browser), configurable: true })
  Object.defineProperty(browser.HTMLElement.prototype, 'getBoundingClientRect', { configurable: true,
    value: () => new browser.DOMRect(0, 0, 1100, 720) })
  const Visibility = class {
    constructor(readonly callback: (entries: unknown[], observer: unknown) => void) {}
    observe(target: unknown) { this.callback([{ target, isIntersecting: true, contentRect: { width: 1100, height: 720 } }], this) }
    unobserve() {} disconnect() {}
  }
  Object.defineProperty(globalThis, 'IntersectionObserver', { value: Visibility, configurable: true })
  Object.defineProperty(browser, 'IntersectionObserver', { value: Visibility, configurable: true })
}
if (phase === 'restore') {
  const storage = JSON.parse(await readFile(storagePath!, 'utf8')) as Record<string, string>
  for (const [key, value] of Object.entries(storage)) browser.localStorage.setItem(key, value)
}

const { AgentMuxSpatialStateStore } = await import('@agentmux/core/spatial-state')
const { useAppStore, prepareRendererUpdate } = await import('../../src/renderer/src/store')
const { api } = await import('../../src/renderer/src/lib/api')
const { createWorkspaceLayout } = await import('@agentmux/layout')
const { createWorkbenchTab, addWorkbenchRegion } = await import('../../src/renderer/src/lib/workbench-tabs')
const { desktopSpatialGraph } = await import('../../src/renderer/src/lib/desktop-spatial-state')
const { spatialCatalog } = await import('../../src/renderer/src/lib/space-agent-control')
const { workbenchObjectLayout } = await import('../../src/renderer/src/lib/desktop-focus-navigation')
const fixture = await import('./mote-workface')
const { scratchTopicsScope } = await import('../../src/renderer/src/lib/scratch-topic-snapshots')
const owner = new AgentMuxSpatialStateStore(spatialPath!)
const current = { hostId: 'local', sessionId: fixture.defaultAgent.id, displayWorkspaceId: fixture.scratchWorkspace.id,
  groupId: 'mote-group', tabId: fixture.defaultTab.id, regionId: fixture.defaultTab.layout.activeRegionId }
const topics = moteMode ? fixture.moteTopics.map((topic, index) => index ? topic : { ...topic,
  quickMode: { status: 'saved' as const, version: 'retained-main-file', defaults: { conversation: current } } }) : fixture.moteTopics
const originalEvent = 'retained-original-work-event'
const lifecycleCalls: string[] = [], continuityRequests: unknown[] = []
for (const method of ['launchAgent', 'launchTerminal', 'recover', 'resume', 'stop', 'submitPrompt', 'write', 'interrupt', 'attach'] as const) {
  if (method === 'recover') continue
  Object.assign(api.sessions, { [method]: async () => { lifecycleCalls.push(method); throw new Error('Healthy Run lifecycle must not be invoked: ' + method) } })
}
Object.assign(api.spatial, {
  read: () => owner.readForLayout(), commit: (input: Parameters<typeof owner.commit>[0]) => owner.commit(input),
  retainLabels: (input: Parameters<typeof owner.retainDisplayLabels>[0]) => owner.retainDisplayLabels(input),
  onChange: (listener: Parameters<typeof owner.subscribe>[0]) => owner.subscribe(listener)
})
api.config.get = async () => structuredClone(fixture.moteConfig)
api.providers.list = async () => ({ catalog: [], warnings: [] })
api.demands.list = async () => []
api.sessions.snapshot = async () => ({ sessions: structuredClone(fixture.moteSessions), timelines: {}, recoveryCandidates: [] })
api.scratch.listTopics = async () => structuredClone(topics)
api.scratch.ensureMote = async () => structuredClone(topics[0]!)
api.scratch.readTopic = async (_workspace, id) => structuredClone(topics.find(topic => topic.id === id) ?? null)
api.ui.requestStorageFlush = async () => {}
api.ui.spatialLinksReady = async () => {}
useAppStore.setState({ scratchTopicSnapshots: { [fixture.scratchWorkspace.id]: {
  scope: scratchTopicsScope(fixture.scratchWorkspace), revision: 1,
  topics, error: null, reading: false
} } })

if (phase === 'save') {
  const workTab = addWorkbenchRegion(createWorkbenchTab('work-tab', {
    kind: 'agent', phase: 'attached', workspaceId: 'project', regionId: 'work-agent', sessionId: fixture.executionAgent.id
  }), 'work-agent', 'right', { kind: 'file', workspaceId: 'project', regionId: 'work-file', path: 'original.md' })
  const tabs = { ...fixture.moteTabs, [workTab.id]: workTab }
  const layouts = {
    [fixture.scratchWorkspace.id]: createWorkspaceLayout('mote-group', Object.keys(fixture.moteTabs)),
    project: createWorkspaceLayout('work-group', ['work-tab', fixture.defaultTab.id])
  }
  await owner.commit({ expectedRevision: 0, graph: desktopSpatialGraph({ config: fixture.moteConfig,
    sessions: fixture.moteSessions, tabs, layouts, spaceZoneBindings: {}, spatialRequests: {} }, topics) })
}
// Runtime is the controlled leaf: ordinary startup continuity can observe the
// exact original healthy Run. It cannot create a Session or replace its Run.
api.sessions.recover = async (control, workspacePath, operationId, request) => {
  const original = fixture.moteSessions.find(session => JSON.stringify(session.control) === JSON.stringify(control))
  if (!original || original.workspacePath !== workspacePath) throw new Error('Continuity requested another original target')
  continuityRequests.push({ control, workspacePath, operationId, trigger: request?.trigger })
  return { kind: 'reattachable', session: structuredClone(original) }
}
if (moteMode) {
  api.moteDialogue.read = async input => ({ main: { target: input.target, identity: { hostId: fixture.scratchWorkspace.hostId, moteId: fixture.moteTopics[0]!.id },
    status: 'ready', resource: null, documentRevision: 'retained-main-file', roleRevision: 'retained-main-role', current, issue: null },
    links: input.eventId && input.eventId !== originalEvent ? [] : [{ kind: 'work', sequence: 1, identity: { hostId: fixture.scratchWorkspace.hostId, moteId: fixture.moteTopics[0]!.id }, operationId: 'retained-work-source', associatedAt: 1,
      eventId: originalEvent, mainRoleRevision: 'retained-main-role', main: { hostId: current.hostId, agentSessionId: current.sessionId },
      origin: { hostId: 'local', messageId: 'retained-message', threadId: 'retained-thread', senderSessionId: current.sessionId, recipientSessionId: fixture.neighborAgent.id, createdAt: 1 } }],
    incarnation: 'retained-dialogue', throughSequence: 1, next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null })
  api.sessions.dispatch = async () => ({ hostId: 'local', source: { envelope: { messageId: 'retained-message', threadId: 'retained-thread', senderSessionId: current.sessionId, recipientSessionId: fixture.neighborAgent.id, body: 'Retained work assignment' } },
    dispatch: { sourceMessageId: 'retained-message', ownerAgentSessionId: current.sessionId, workerAgentSessionId: fixture.neighborAgent.id, threadId: 'retained-thread', openedAt: 1, originAwaits: true, events: [] }, replies: [], identityDiagnostics: [] }) as never
  const { DEFAULT_AGENT_CONTINUITY_POLICY } = await import('@agentmux/core/agent-session-recovery')
  // A controlled original healthy-Run observation, not a new runtime or a recovery success proof.
  api.moteDialogue.inspectRecovery = async request => ({ operation: { operationId: request.operationId,
    agentSessionId: request.reference.sessionId, trigger: 'manual', previousRun: request.expectedRun,
    policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY }, admittedAt: 1, observedAt: 1, rechecks: 0,
    kind: 'reattachable', reason: 'reattachable', evidence: { kind: 'run-running', observedAt: 1 },
    moteMainEntry: { target: request.target, expectedRoleRevision: request.expectedRoleRevision, reference: request.reference } } })
  api.moteDialogue.ensureRecovery = async () => { lifecycleCalls.push('mote.ensureRecovery'); throw new Error('This controlled healthy Run needs no lifecycle operation') }
  api.files.readDirectory = async () => []
}
stage('initialize')
const dispose = await useAppStore.getState().initialize()
stage('initialized')
if (useAppStore.getState().loading || useAppStore.getState().error) throw new Error('Production startup failed: ' + useAppStore.getState().error)

let unmount: (() => Promise<void>) | undefined
if (moteMode) {
  const React = await import('react'), { createRoot } = await import('react-dom/client')
  const { App } = await import('../../src/renderer/src/App')
  const { DesktopClientUiProvider } = await import('../../src/renderer/src/components/DesktopClientUiProvider')
  const restorePopover = fixture.installNativePopover()
  // Real initialize already ran above. App reuses that initialized owner; Native paint is the isolated leaf.
  useAppStore.setState({ initialize: async () => () => {}, loading: false, prewarmTerminal: async () => {}, detectExecutors: async () => {} })
  const mount = browser.document.createElement('div'); browser.document.body.append(mount)
  const root = createRoot(mount)
  stage('mount-app')
  root.render(React.createElement(DesktopClientUiProvider, null, React.createElement(App)))
  await new Promise(resolve => setTimeout(resolve, 150))
  stage('mounted-app')
  unmount = async () => { root.unmount(); restorePopover(); await new Promise(resolve => setImmediate(resolve)) }
}
const { SpatialLinkIngress } = await import('../../src/main/spatial-link-ingress')
const { formatSessionAddress, formatMoteAddress, parseAmuxObjectLink } = await import('@agentmux/core/sharing')
const moteSpace = spatialCatalog(useAppStore.getState(), topics).spaces.find(space => space.kind === 'mote' && space.topicId === fixture.moteTopics[0]!.id)
const raw = moteMode ? formatMoteAddress({ spaceId: moteSpace!.spaceId, ...(mode === 'mote-thread' ? { eventId: originalEvent } : {}) }) : formatSessionAddress(fixture.executionAgent.id)
const requests: string[] = [], issues: string[] = []
const beforeReopen = moteMode ? { work: useAppStore.getState().workbenchSpaceSelection, visible: Boolean(browser.document.querySelector('[data-mote-space-id]')), page: browser.document.querySelector<HTMLElement>('[data-mote-space-id]')?.dataset.motePage } : undefined
if (phase === 'save' || moteMode && mode === 'mote-thread') {
  if (phase === 'save') useAppStore.getState().focusRegion('project', 'work-tab', 'work-file', 'navigation', 'work-group')
  if (phase === 'save') useAppStore.setState({ agentComposerDrafts: moteMode ? { [fixture.defaultAgent.id]: 'Unsent Mote main draft', [fixture.neighborAgent.id]: 'Unsent Mote member draft', [fixture.executionAgent.id]: 'Unsent original draft' } : { [fixture.executionAgent.id]: 'Unsent original draft' } })
  const before = useAppStore.getState()
  const ingress = new SpatialLinkIngress()
  // Simulate a cold native URL that waits for the original Renderer readiness.
  stage('open-uri')
  const opening = ingress.receive(raw)
  ingress.ready(async request => {
    requests.push(request.operation)
    return await useAppStore.getState().executeControl(request)
  }, message => issues.push(message))
  await opening
  stage('opened-uri')
  await new Promise(resolve => setImmediate(resolve))
  deepStrictEqual(useAppStore.getState().sessions, before.sessions, 'Link must retain original Sessions')
  deepStrictEqual(useAppStore.getState().agentComposerDrafts, before.agentComposerDrafts, 'Link must retain original draft')
}
stage('flush')
await prepareRendererUpdate()
stage('flushed')
const state = useAppStore.getState()
const storage = Object.fromEntries(Array.from({ length: browser.localStorage.length }, (_, index) => {
  const key = browser.localStorage.key(index)!
  return [key, browser.localStorage.getItem(key)!]
}))
if (phase === 'save') await writeFile(storagePath!, JSON.stringify(storage))
const moteFrame = moteMode ? browser.document.querySelector<HTMLElement>('[data-mote-space-id]') : null
const proof = { pid: process.pid, stages, raw, target: parseAmuxObjectLink(raw), work: state.workbenchSpaceSelection,
  ...(moteMode ? { beforeReopen, mote: { spaceId: moteFrame?.dataset.moteSpaceId, topicId: moteFrame?.dataset.moteSpace,
    visible: Boolean(moteFrame && !moteFrame.closest('[hidden], [inert]')), page: moteFrame?.dataset.motePage,
    eventId: moteFrame?.querySelector<HTMLElement>('[data-mote-work-thread]')?.dataset.moteWorkThread,
    threadBody: [...moteFrame?.querySelectorAll<HTMLElement>('[data-mote-work-thread] blockquote') ?? []].some(body => body.textContent?.includes('Retained work assignment') && !body.closest('[hidden], [inert]') && browser.getComputedStyle(body).display !== 'none' && browser.getComputedStyle(body).visibility !== 'hidden'),
    mainBody: [...moteFrame?.querySelectorAll<HTMLElement>('[data-activity-session="' + fixture.defaultAgent.id + '"]') ?? []].some(body => !body.closest('[hidden], [inert]') && browser.getComputedStyle(body).display !== 'none' && browser.getComputedStyle(body).visibility !== 'hidden') } } : {}),
  tabs: state.tabs, layouts: state.layouts, drafts: state.agentComposerDrafts,
  sessions: state.sessions.map(session => ({ id: session.id, processState: session.processState, control: session.control })),
  graph: (await owner.read())!.graph, requests, issues, lifecycleCalls, continuityRequests }
await unmount?.()
dispose?.()
await browser.happyDOM.abort()
clearInterval(shellLease)
await new Promise<void>(resolve => process.stdout.write(JSON.stringify(proof), () => resolve()))
process.exit(0)
