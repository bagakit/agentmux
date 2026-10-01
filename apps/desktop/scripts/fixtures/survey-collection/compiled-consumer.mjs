import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const [root, compiled, evidence, phase] = process.argv.slice(2)
const require = createRequire(join(root, 'apps/desktop/package.json'))
const { Window } = await import(pathToFileURL(require.resolve('happy-dom')).href)
const window = new Window({ url: 'http://private.invalid' })
globalThis.window = window; globalThis.document = window.document; globalThis.localStorage = window.localStorage
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
if (phase === 'restore') for (const name of ['agentmux-workbench-v1', 'agentmux-launcher']) window.localStorage.setItem(name, await readFile(join(evidence, `${name}.json`), 'utf8'))
const { useAppStore, prepareRendererUpdate, api, useLauncherState, createWorkbenchTab, addWorkbenchRegion, documentKey, spatialCatalog, surveyZoneItems, createWorkspaceLayout, directoryIdentity } = await import(pathToFileURL(join(compiled, 'consumer.mjs')).href)
const { workspaces } = JSON.parse(await readFile(join(evidence, 'private-resources.json'), 'utf8'))
const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {}, workspaces, appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
api.config.get = async () => config; api.providers.list = async () => []; api.demands.list = async () => []; api.scratch.listTopics = async () => []
api.sessions.snapshot = async () => ({ sessions: [], timelines: {}, recoveryCandidates: [] }); api.ui.requestStorageFlush = async () => undefined
// A confirmed deterministic transport fact keeps transient Browser snapshots out of this persistence claim.
api.browser.create = async (id, url) => ({ id, url, title: 'Original browser fact', navigationId: 'saved-navigation', profileId: '11111111-1111-4111-8111-111111111111', loading: false, canGoBack: false, canGoForward: false, viewport: 'responsive', error: null, driving: false, appLinkPrompt: null })
const dispose = await useAppStore.getState().initialize(); dispose()
const items = () => surveyZoneItems(spatialCatalog(useAppStore.getState(), []), useAppStore.getState().surveyCollectedZones).map(zone => zone.zoneId).sort()
try {
 if (phase === 'seed') {
  const owner = useAppStore.getState(), resource = workspaces.find(value => value.id === 'resource')
  const zones = await Promise.all(['browser', 'file', 'execution'].map(() => owner.createWorkbenchZone({ workspaceId: resource.id, spaceIds: [] })))
  const spaceId = directoryIdentity(resource.hostId, resource.path)
  const browser = createWorkbenchTab('browser-tab', { kind: 'browser', regionId: 'browser-region', workspaceId: resource.id, browserId: 'browser-region', ...await api.browser.create('browser-region', 'https://example.invalid/reading') })
  const file = addWorkbenchRegion(createWorkbenchTab('mixed-file-tab', { kind: 'launcher', regionId: 'first-launcher', workspaceId: resource.id }), 'first-launcher', 'right', { kind: 'file', regionId: 'second-file', workspaceId: resource.id, path: 'Unsent.note.json' })
  const execution = createWorkbenchTab('execution-tab', { kind: 'launcher', regionId: 'execution-launcher', workspaceId: resource.id })
  for (const [index, tab] of [browser, file, execution].entries()) tab.space = { zoneId: zones[index].zone.zoneId, spaceId }
  const original = createWorkspaceLayout('first-group', [browser.id, file.id, execution.id])
  const display = { ...original, root: { type: 'split', direction: 'horizontal', ratio: .37, first: original.root, second: { type: 'leaf', groupId: 'second-group' } }, groups: [...original.groups, { id: 'second-group', tabOrder: [file.id], activeTabId: file.id, recentTabIds: [file.id] }] }
  const key = documentKey(resource.id, 'Unsent.note.json'), content = '{"original":"unsaved exact File draft"}'
  useAppStore.setState({ activeWorkspaceId: 'display', mainSurface: 'survey', layouts: { resource: createWorkspaceLayout('resource-group'), display }, tabs: { [browser.id]: browser, [file.id]: file, [execution.id]: execution }, documents: { [key]: { path: 'Unsent.note.json', content, revision: 'saved-revision' } } })
  owner.updateDocument(file.id, content + '\n', 'second-file')
  assert.equal(owner.setSurveyZoneCollected(zones[1].zone.zoneId, true), true)
  const reference = { displayWorkspaceId: 'display', groupId: 'second-group', tabId: file.id, regionId: 'second-file' }
  owner.setSurveyZoneSelection({ zoneId: zones[1].zone.zoneId, selection: [reference], active: reference })
  assert.equal(owner.setSurveyExplorationName(zones[1].zone.zoneId, 'Reading into a durable idea'), true)
  owner.setSurveySidebarCollapsed(true); owner.setSurveySidebarWidth(213)
  useAppStore.setState(state => ({ surveyCollectedZones: { ...state.surveyCollectedZones, 'retained-unknown-zone': true } }))
  useLauncherState.getState().setDraft('region:first-launcher', 'note', 'Unsent Launcher input')
  assert.deepEqual(items(), [zones[0].zone.zoneId, zones[1].zone.zoneId].sort())
  assert.equal(useAppStore.getState().surveyCollectedZones[zones[0].zone.zoneId], undefined)
  assert.equal(useAppStore.getState().surveyCollectedZones[zones[2].zone.zoneId], undefined)
  await prepareRendererUpdate('quit')
  for (const name of ['agentmux-workbench-v1', 'agentmux-launcher']) { const saved = window.localStorage.getItem(name); assert.ok(saved); await writeFile(join(evidence, `${name}.json`), saved) }
  await writeFile(join(evidence, 'expected.json'), JSON.stringify({ items: items(), layouts: useAppStore.getState().layouts, tabs: useAppStore.getState().tabs, selection: useAppStore.getState().surveyZoneSelection, collected: useAppStore.getState().surveyCollectedZones, names: useAppStore.getState().surveyExplorationNames, sidebarCollapsed: true, sidebarWidth: 213, key, content: content + '\n', launcherDraft: useLauncherState.getState().drafts['region:first-launcher'] }))
 } else {
  const expected = JSON.parse(await readFile(join(evidence, 'expected.json'), 'utf8')), current = useAppStore.getState()
  assert.deepEqual(current.tabs, expected.tabs); assert.deepEqual(current.layouts, expected.layouts)
  assert.deepEqual(current.surveyZoneSelection, expected.selection); assert.deepEqual(current.surveyCollectedZones, expected.collected)
  assert.deepEqual(current.surveyExplorationNames, expected.names); assert.equal(Object.values(current.surveyExplorationNames)[0], 'Reading into a durable idea')
  assert.equal(current.mainSurface, 'survey'); assert.equal(current.surveySidebarCollapsed, true); assert.equal(current.surveySidebarWidth, 213)
  assert.equal(current.documents[expected.key].content, expected.content); assert.equal(current.dirtyDocuments[expected.key], true)
  assert.deepEqual(useLauncherState.getState().drafts['region:first-launcher'], expected.launcherDraft)
  assert.deepEqual(items(), expected.items); assert.equal(items().length, 2)
  assert.equal(current.surveyCollectedZones['retained-unknown-zone'], true)
 }
 await writeFile(join(evidence, `${phase}.json`), JSON.stringify({ passed: true, phase, pid: process.pid, items: items(), collection: useAppStore.getState().surveyCollectedZones, selection: useAppStore.getState().surveyZoneSelection, sidebarCollapsed: useAppStore.getState().surveySidebarCollapsed, sidebarWidth: useAppStore.getState().surveySidebarWidth, boundary: 'Real Store persistence in distinct processes; Browser-kind facts only, no Native, live Run or DOM caret claim.' }))
} finally { await window.happyDOM.abort() }
console.log(JSON.stringify({ passed: true, phase, pid: process.pid }))
