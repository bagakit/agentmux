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
const { mainFocusPresentation } = await import('../../src/renderer/src/lib/focus-tab-projection')
const { resolveWorkbenchZone } = await import('../../src/renderer/src/lib/workbench-projection')
const { surveyResolvedZoneSelection } = await import('../../src/renderer/src/lib/survey-workface')
const floatingOwner = await import('../../src/renderer/src/lib/pmo-teams-topic-floating')
const { moteWorkbenchProjection } = await import('../../src/renderer/src/lib/mote-workbench-projection')
const fixture = await import('./mote-workface')
const { scratchTopicsScope } = await import('../../src/renderer/src/lib/scratch-topic-snapshots')
const { createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { flushSync } = await import('react-dom')

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
api.providers.list = async () => []
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

if (phase === 'save') {
  const catalog = spatialCatalog(useAppStore.getState(), fixture.moteTopics)
  const surveyReference = { displayWorkspaceId: fixture.scratchWorkspace.id, groupId: 'mote-group',
    tabId: fixture.ordinaryTab.id, regionId: 'ordinary-region' }
  const zoneId = catalog.tabs.find(tab => tab.tabId === surveyReference.tabId)!.zoneId!
  useAppStore.getState().focusRegion('project', 'work-tab', 'work-file', 'navigation', 'work-group')
  const originalWork = structuredClone(useAppStore.getState().workbenchSpaceSelection)
  useAppStore.getState().setSurveyZoneSelection({ zoneId, selection: [surveyReference], active: surveyReference })
  deepStrictEqual(useAppStore.getState().workbenchSpaceSelection, originalWork, 'Survey selection must preserve Work')
  const originalSurvey = structuredClone(useAppStore.getState().surveyZoneSelection)
  floatingOwner.requestPmoTeamsTopicFloatingOpen({ targetTopicId: fixture.defaultTab.topicId,
    targetTabId: fixture.defaultTab.id, reference: { displayWorkspaceId: fixture.scratchWorkspace.id,
      groupId: 'mote-group', tabId: fixture.defaultTab.id, regionId: 'default-region' } })
  deepStrictEqual(useAppStore.getState().workbenchSpaceSelection, originalWork, 'Mote selection must preserve Work')
  deepStrictEqual(useAppStore.getState().surveyZoneSelection, originalSurvey, 'Mote selection must preserve Survey')
  const originalMote = structuredClone(floatingOwner.readPmoTeamsTopicFloatingState())
  useAppStore.getState().focusRegion('project', 'work-tab', 'work-agent', 'navigation', 'work-group')
  deepStrictEqual(useAppStore.getState().surveyZoneSelection, originalSurvey, 'Work selection must preserve Survey')
  deepStrictEqual(floatingOwner.readPmoTeamsTopicFloatingState(), originalMote, 'Work selection must preserve Mote')
  const retainedWork = structuredClone(useAppStore.getState().workbenchSpaceSelection)
  const neighborReference = { displayWorkspaceId: fixture.scratchWorkspace.id, groupId: 'mote-group',
    tabId: fixture.neighborTab.id, regionId: 'neighbor-region' }
  const neighborZoneId = catalog.tabs.find(tab => tab.tabId === neighborReference.tabId)!.zoneId!
  for (const selection of [
    { zoneId: neighborZoneId, selection: [neighborReference], active: neighborReference },
    { zoneId, selection: [surveyReference], active: surveyReference }
  ]) {
    useAppStore.getState().setSurveyZoneSelection(selection)
    deepStrictEqual(useAppStore.getState().workbenchSpaceSelection, retainedWork, 'Survey retarget must preserve existing Work')
    deepStrictEqual(floatingOwner.readPmoTeamsTopicFloatingState(), originalMote, 'Survey retarget must preserve existing Mote')
  }
  for (const reference of [neighborReference, originalMote!.reference!]) {
    floatingOwner.requestPmoTeamsTopicFloatingOpen({ targetTopicId: fixture.defaultTab.topicId, targetTabId: reference.tabId, reference })
    deepStrictEqual(useAppStore.getState().workbenchSpaceSelection, retainedWork, 'Mote retarget must preserve existing Work')
    deepStrictEqual(useAppStore.getState().surveyZoneSelection, originalSurvey, 'Mote retarget must preserve existing Survey')
  }
}

// Use the mounted production hook, whose snapshot calls the private readState.
// Reading storage into a test-owned navigation state would miss this boundary.
const host = browser.document.createElement('div')
browser.document.body.append(host)
const root = createRoot(host as unknown as HTMLElement)
let floating!: ReturnType<typeof floatingOwner.usePmoTeamsTopicFloatingState>[0]
function FloatingConsumer() { [floating] = floatingOwner.usePmoTeamsTopicFloatingState(); return null }
flushSync(() => root.render(createElement(FloatingConsumer)))
await prepareRendererUpdate()
const state = useAppStore.getState()
const catalog = spatialCatalog(state, fixture.moteTopics)
const moteTabId = floatingOwner.pmoTeamsTopicFloatingTargetTabId(floating, state.tabs,
  state.layouts[fixture.scratchWorkspace.id], state.agentFocus.pmo.sessionId)
const mote = moteWorkbenchProjection(catalog, moteTabId ? state.tabs[moteTabId] : undefined, floating, () => {}, state.layouts)
const focus = mainFocusPresentation(state.workbenchSpaceSelection, state.tabs, catalog, () => {})
const survey = state.surveyZoneSelection!
const surveyProjection = resolveWorkbenchZone(survey.zoneId, catalog, state.layouts, state.tabs, 'survey-workbench', survey.selection, () => {})
const storage = Object.fromEntries(Array.from({ length: browser.localStorage.length }, (_, index) => {
  const key = browser.localStorage.key(index)!
  return [key, browser.localStorage.getItem(key)!]
}))
if (phase === 'save') await writeFile(storagePath!, JSON.stringify(storage))
const proof = { pid: process.pid, work: state.workbenchSpaceSelection, survey,
  floating, surveyResolved: surveyResolvedZoneSelection(survey, surveyProjection),
  workProjection: workbenchObjectLayout(state, 'project'),
  focus: { selection: focus.projection?.selection ?? null, issue: focus.issue },
  mote: { selection: mote.projection?.selection ?? null, retainedTabId: mote.retainedTabId, issue: mote.issue },
  tabs: state.tabs, layouts: state.layouts,
  sessions: state.sessions.map(session => ({ id: session.id, processState: session.processState, control: session.control })),
  graph: (await owner.read())!.graph, storage, lifecycleCalls }
flushSync(() => root.unmount())
dispose?.()
await browser.happyDOM.abort()
await new Promise<void>(resolve => process.stdout.write(JSON.stringify(proof), () => resolve()))
process.exit(0)
