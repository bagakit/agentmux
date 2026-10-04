import { readFile, writeFile } from 'node:fs/promises'
import { deepStrictEqual } from 'node:assert/strict'
import { Window } from 'happy-dom'

// Browser and IPC boundaries only. Both processes load the real renderer owners
// after installing their browser storage, and share the real Core document.
const [phase, spatialPath, storagePath] = process.argv.slice(2)
const browser = new Window({ url: 'http://navigation-restore.test' })
for (const [key, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator,
  HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser)
})) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
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
const lifecycleCalls: string[] = []
for (const method of ['launchAgent', 'launchTerminal', 'recover', 'resume', 'stop', 'submitPrompt', 'write', 'interrupt', 'attach'] as const) {
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
api.scratch.listTopics = async () => structuredClone(fixture.moteTopics)
api.scratch.ensureMote = async () => structuredClone(fixture.moteTopics[0]!)
api.ui.requestStorageFlush = async () => {}
api.ui.spatialLinksReady = async () => {}
useAppStore.setState({ scratchTopicSnapshots: { [fixture.scratchWorkspace.id]: {
  scope: scratchTopicsScope(fixture.scratchWorkspace), revision: 1,
  topics: fixture.moteTopics, error: null, reading: false
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
    sessions: fixture.moteSessions, tabs, layouts, spaceZoneBindings: {}, spatialRequests: {} }, fixture.moteTopics) })
}
const dispose = await useAppStore.getState().initialize()
if (useAppStore.getState().loading || useAppStore.getState().error) throw new Error('Production startup failed: ' + useAppStore.getState().error)

const { SpatialLinkIngress } = await import('../../src/main/spatial-link-ingress')
const { formatSessionAddress, parseAmuxObjectLink } = await import('@agentmux/core/sharing')
const raw = formatSessionAddress(fixture.executionAgent.id)
const requests: string[] = [], issues: string[] = []
if (phase === 'save') {
  useAppStore.getState().focusRegion('project', 'work-tab', 'work-file', 'navigation', 'work-group')
  useAppStore.setState({ agentComposerDrafts: { [fixture.executionAgent.id]: 'Unsent original draft' } })
  const before = useAppStore.getState()
  const ingress = new SpatialLinkIngress()
  // Simulate a cold native URL that waits for the original Renderer readiness.
  ingress.receive(raw)
  let done!: () => void
  const completed = new Promise<void>(resolve => { done = resolve })
  ingress.ready(async request => {
    requests.push(request.operation)
    const result = await useAppStore.getState().executeControl(request)
    if (request.operation === 'focus') done()
    return result
  }, message => issues.push(message))
  await completed
  await new Promise(resolve => setImmediate(resolve))
  deepStrictEqual(useAppStore.getState().sessions, before.sessions, 'Link must retain original Sessions')
  deepStrictEqual(useAppStore.getState().agentComposerDrafts, before.agentComposerDrafts, 'Link must retain original draft')
}
await prepareRendererUpdate()
const state = useAppStore.getState()
const storage = Object.fromEntries(Array.from({ length: browser.localStorage.length }, (_, index) => {
  const key = browser.localStorage.key(index)!
  return [key, browser.localStorage.getItem(key)!]
}))
if (phase === 'save') await writeFile(storagePath!, JSON.stringify(storage))
const proof = { pid: process.pid, raw, target: parseAmuxObjectLink(raw), work: state.workbenchSpaceSelection,
  tabs: state.tabs, layouts: state.layouts, drafts: state.agentComposerDrafts,
  sessions: state.sessions.map(session => ({ id: session.id, processState: session.processState, control: session.control })),
  graph: (await owner.read())!.graph, requests, issues, lifecycleCalls }
dispose?.()
await browser.happyDOM.abort()
await new Promise<void>(resolve => process.stdout.write(JSON.stringify(proof), () => resolve()))
process.exit(0)
