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
const setup = JSON.parse(await readFile(join(evidence, 'private-resources.json'), 'utf8'))
if (phase === 'restore') for (const name of ['agentmux-workbench-v1', 'agentmux-launcher']) window.localStorage.setItem(name, await readFile(join(evidence, `${name}.json`), 'utf8'))
const { useAppStore, prepareRendererUpdate, api, useLauncherState, WorkspaceFiles, createWorkbenchTab, addWorkbenchRegion, documentKey, fileTabId,
  spatialCatalog, directoryIdentity, readNoteDocument, loadedNoteFiles, noteKnowledge, noteBacklinks, resolveNoteBlock, createWorkspaceLayout, noteBlockSelectionKey, workbenchProjectionSlotId } = await import(pathToFileURL(join(compiled, 'consumer.mjs')).href)
const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {}, workspaces: setup.workspaces,
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const resource = config.workspaces.find(workspace => workspace.id === 'resource')
const files = new WorkspaceFiles(id => ({ id, kind: 'local', label: 'Local', run: () => { throw new Error('No Run is permitted in this fixture') }, exposeLoopbackPort: async port => port, dispose: async () => {} }))
const observations = new Map()
api.config.get = async () => config; api.providers.list = async () => []; api.demands.list = async () => []; api.scratch.listTopics = async () => []
api.sessions.snapshot = async () => ({ sessions: [], timelines: {}, recoveryCandidates: [] }); api.ui.requestStorageFlush = async () => undefined
api.files.write = async (id, input) => { assert.equal(id, resource.id); return await files.write(resource, input) }
api.files.read = async (id, path) => { assert.equal(id, resource.id); return await files.read(resource, path) }
api.files.observe = async (id, path) => { assert.equal(id, resource.id); const key = documentKey(id, path); if (!observations.has(key)) observations.set(key, await files.observe(resource, path, () => {})) }
api.files.unobserve = async (id, path) => { const key = documentKey(id, path); await observations.get(key)?.(); observations.delete(key) }
const dispose = await useAppStore.getState().initialize(); dispose()
const facts = () => noteKnowledge(loadedNoteFiles(useAppStore.getState().documents), 'partial')
const parse = raw => { const read = readNoteDocument(raw); assert.equal(read.status, 'valid'); return read.note }
try {
  if (phase === 'seed') {
    const zone = 'temporary-note-zone', spaceId = directoryIdentity('local', resource.path)
    const launcher = { ...createWorkbenchTab('note-launcher', { kind: 'launcher', regionId: 'launcher-region', workspaceId: resource.id }), space: { zoneId: zone, spaceId } }
    const first = createWorkspaceLayout('foreign', [launcher.id])
    const display = { ...first, root: { type: 'split', direction: 'horizontal', ratio: .5, first: first.root, second: { type: 'leaf', groupId: 'second' } }, groups: [...first.groups, { id: 'second', tabOrder: [], activeTabId: null, recentTabIds: [] }] }
    useAppStore.setState({ activeWorkspaceId: 'display', tabs: { [launcher.id]: launcher }, layouts: { resource: createWorkspaceLayout('resource-group'), display },
      spaceZoneBindings: { [zone]: { workspaceId: resource.id, spaceId, relations: { [spaceId]: false } } } })
    const launcherRef = { tabId: launcher.id, regionId: 'launcher-region' }
    const a = await useAppStore.getState().createNote('foreign', launcherRef, 'Saved A')
    assert.equal(a.status, 'written'); assert.equal(a.revealed, true)
    useAppStore.getState().activateTab('display', 'foreign', launcher.id)
    const b = await useAppStore.getState().createNote('foreign', launcherRef, 'Saved B')
    assert.equal(b.status, 'written'); assert.equal(b.revealed, true); assert.notEqual(a.path, b.path); assert.notEqual(a.noteId, b.noteId)
    const aTabId = fileTabId(resource.id, a.path), bTabId = fileTabId(resource.id, b.path)
    const aTab = useAppStore.getState().tabs[aTabId], aRegion = Object.values(aTab.regions).find(region => region.kind === 'file')
    const bRegion = Object.values(useAppStore.getState().tabs[bTabId].regions).find(region => region.kind === 'file')
    useAppStore.setState(state => ({ tabs: { ...state.tabs, [aTabId]: addWorkbenchRegion(aTab, aRegion.regionId, 'left', { kind: 'launcher', regionId: 'retained-first-region', workspaceId: resource.id }) } }))
    useAppStore.getState().focusRegion('display', aTabId, aRegion.regionId)
    assert.equal(useAppStore.getState().tabs[aTabId].layout.root.type, 'split')
    const aContent = parse(useAppStore.getState().documents[documentKey(resource.id, a.path)].content), target = { noteId: a.noteId, blockId: crypto.randomUUID() }
    aContent.content.content.push({ type: 'paragraph', attrs: { blockId: target.blockId }, content: [{ type: 'text', text: 'Unsent original second block' }] })
    const dirtyA = JSON.stringify(aContent, null, 2)
    useAppStore.getState().updateDocument(aTabId, dirtyA, aRegion.regionId)
    const bContent = parse(useAppStore.getState().documents[documentKey(resource.id, b.path)].content)
    for (const mode of ['reference', 'embed']) bContent.content.content.push({ type: 'blockReference', attrs: { blockId: crypto.randomUUID(), referenceId: crypto.randomUUID(), target, mode } })
    useAppStore.getState().updateDocument(bTabId, JSON.stringify(bContent, null, 2), bRegion.regionId)
    await useAppStore.getState().saveDocument(bTabId, bRegion.regionId)
    assert.equal(Boolean(useAppStore.getState().dirtyDocuments[documentKey(resource.id, b.path)]), false)
    assert.equal((await useAppStore.getState().setTabDisplayPlacement(bTabId, 'display', 'second', true)).outcome, 'linked')
    const refs = [{ displayWorkspaceId: 'display', groupId: 'foreign', tabId: aTabId, regionId: aRegion.regionId }, { displayWorkspaceId: 'display', groupId: 'second', tabId: bTabId, regionId: bRegion.regionId }]
    useAppStore.getState().setMainSurface('survey'); useAppStore.getState().setSurveyZoneSelection({ zoneId: zone, selection: refs, active: refs[1] })
    for (const [reference, targetBlock] of [[refs[0], target], [refs[1], { noteId: b.noteId, blockId: bContent.content.content[1].attrs.blockId }]]) useAppStore.getState().setNoteBlockSelection({ tabHostId: workbenchProjectionSlotId('private-survey-slot', reference), reference }, targetBlock)
    assert.equal(Object.keys(useAppStore.getState().noteBlockSelections).length, 2)
    useLauncherState.getState().setDraft('region:launcher-region', 'note', 'Unsent Launcher input after creation')
    const knowledge = facts(), links = noteBacklinks(knowledge, target)
    assert.equal(knowledge.sources.length, 2); assert.equal(links.length, 2); assert.equal(resolveNoteBlock(knowledge, target).status, 'resolved')
    await prepareRendererUpdate('quit')
    for (const name of ['agentmux-workbench-v1', 'agentmux-launcher']) { const saved = window.localStorage.getItem(name); assert.ok(saved); await writeFile(join(evidence, `${name}.json`), saved) }
    await writeFile(join(evidence, 'expected.json'), JSON.stringify({ a, b, aTabId, bTabId, target, dirtyA, layouts: useAppStore.getState().layouts, tabs: useAppStore.getState().tabs,
      surveyZoneSelection: useAppStore.getState().surveyZoneSelection, noteBlockSelections: useAppStore.getState().noteBlockSelections, launcherDraft: useLauncherState.getState().drafts['region:launcher-region'], references: knowledge.references.map(link => ({ blockId: link.blockId, referenceId: link.referenceId, target: link.target, mode: link.mode })) }))
  } else {
    const expected = JSON.parse(await readFile(join(evidence, 'expected.json'), 'utf8'))
    assert.deepEqual(useAppStore.getState().layouts, expected.layouts); assert.deepEqual(useAppStore.getState().tabs, expected.tabs)
    assert.deepEqual(useAppStore.getState().surveyZoneSelection, expected.surveyZoneSelection); assert.equal(useAppStore.getState().mainSurface, 'survey')
    assert.deepEqual(useAppStore.getState().noteBlockSelections, expected.noteBlockSelections)
    assert.equal(Object.keys(useAppStore.getState().noteBlockSelections).length, 2)
    assert.deepEqual(useLauncherState.getState().drafts['region:launcher-region'], expected.launcherDraft)
    const key = documentKey(resource.id, expected.a.path)
    assert.equal(useAppStore.getState().documents[key].content, expected.dirtyA); assert.equal(useAppStore.getState().dirtyDocuments[key], true)
    const aDisk = parse(await readFile(join(resource.path, expected.a.path), 'utf8'))
    assert.equal(aDisk.noteId, expected.a.noteId); assert.equal(aDisk.content.content.length, 1)
    assert.equal(parse(useAppStore.getState().documents[key].content).content.content[1].attrs.blockId, expected.target.blockId)
    const tabs = useAppStore.getState().tabs, layouts = useAppStore.getState().layouts
    await useAppStore.getState().attachPersistedFileDocument(resource.id, expected.b.path)
    assert.equal(useAppStore.getState().tabs, tabs); assert.equal(useAppStore.getState().layouts, layouts)
    const knowledge = facts()
    assert.equal(knowledge.scope, 'partial'); assert.equal(knowledge.sources.length, 2)
    assert.deepEqual(knowledge.references.map(link => ({ blockId: link.blockId, referenceId: link.referenceId, target: link.target, mode: link.mode })), expected.references)
    assert.equal(noteBacklinks(knowledge, expected.target).length, 2)
    const resolved = resolveNoteBlock(knowledge, expected.target); assert.equal(resolved.status, 'resolved'); assert.equal(resolved.block.text, 'Unsent original second block')
  }
  await writeFile(join(evidence, `${phase}.json`), JSON.stringify({ passed: true, phase, pid: process.pid, sourceCount: facts().sources.length, referenceCount: facts().references.length,
    noteBlockSelections: useAppStore.getState().noteBlockSelections, tabs: Object.keys(useAppStore.getState().tabs), layouts: useAppStore.getState().layouts, surveyZoneSelection: useAppStore.getState().surveyZoneSelection,
    boundary: 'Actual compiled Files/Store and original durable Document/Launcher/UI metadata. No DOM caret, native Browser, Session or Run claim.' }))
} finally { await files.dispose(); await window.happyDOM.abort() }
console.log(JSON.stringify({ passed: true, phase, pid: process.pid }))
