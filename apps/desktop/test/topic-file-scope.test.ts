// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { activateTab, createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { addWorkbenchRegion, createWorkbenchTab, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { directoryIdentity, workspaceZoneId, originalTopicAddress } from '../src/shared/space-addresses'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { composerConfig } from './helpers/composer-dom-fixture'
import { act, createElement } from 'react'
import { createClientUiRoot } from './helpers/client-ui-render'
import { FileExplorer } from '../src/renderer/src/components/FileExplorer'
import { installFileTreeGeometry } from './helpers/file-tree-geometry'
import { executeWorkfaceFileOpen, resolveFileOpenTarget } from '../src/renderer/src/lib/workface-file-open'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
vi.mock('../src/renderer/src/hooks/useGitStatus', () => ({ useGitStatus: () => ({ status: null, refresh: async () => true }) }))

const initial = useAppStore.getState()
const workspace = { ...composerConfig.workspaces[0]!, id: '__scratch__', path: '/fixture/scratch' }
const topics = ['work', 'study'].map(name => ({ id: `view:${name}`, title: name, directoryPath: `topic--view--${name}`,
  topicPath: `topic--view--${name}/topic.md`, physicalDirectoryPath: `/fixture/topics/topic--view--${name}`,
  identityDirectoryPath: `/fixture/topics/topic--view--${name}`, confirmedDirectoryPaths: [`/fixture/topics/topic--view--${name}`], summary: '', collaborators: [] }))
const zones = topics.map(topic => originalTopicAddress(workspace, topic, {})!.zoneId)
const contentSpaces = topics.map(topic => originalTopicAddress(workspace, topic, {})!.spaceId)
const tabs = topics.map((topic, i) => ({ ...createWorkbenchTab(`tab-${i}`, { kind: 'launcher' as const, regionId: `region-${i}`, workspaceId: workspace.id }),
  topicId: topic.id, space: { spaceId: contentSpaces[i]!, zoneId: zones[i]! } }))
const path = 'topic--view--study/notes.md'
const selection = (i: number, tabId = tabs[i]!.id, regionId = `region-${i}`) => ({ workspaceId: workspace.id,
  spaceId: `category-${i}`, zoneId: zones[i]!, topicId: topics[i]!.id, tabId, groupId: 'group', regionId })

beforeEach(() => {
  useAppStore.setState(initial, true)
  useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace] }, activeWorkspaceId: workspace.id, mainSurface: 'workbench',
    tabs: Object.fromEntries(tabs.map(tab => [tab.id, tab])), layouts: { [workspace.id]: createWorkspaceLayout('group', tabs.map(tab => tab.id)) },
    sessions: [], documents: {}, documentIssues: {}, dirtyDocuments: {}, documentGenerations: {}, documentObservationGenerations: {},
    workbenchSpaceSelection: selection(1), topicCategories: topics.map((_, i) => ({ categoryId: `cat-${i}`, spaceId: `category-${i}`, title: `Category ${i}`, hostId: 'local', revision: 'original', directoryPath: `/fixture/categories/${i}` })),
    spaceZoneBindings: Object.fromEntries(topics.map((topic, i) => [zones[i]!, { spaceId: contentSpaces[i]!, workspaceId: workspace.id, directoryPath: topic.physicalDirectoryPath,
      topicId: topic.id, contentKind: 'topic' as const, relations: { [`category-${i}`]: true } }])),
    scratchTopicSnapshots: { [workspace.id]: { scope: scratchTopicsScope(workspace), topics, revision: 0, reading: false, error: null } }, error: null })
  vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'read').mockImplementation(async (_id, requestedPath) => ({ status: 'read', document: { path: requestedPath, content: 'STUDY FILE', revision: 'original' } }))
})
afterEach(() => { useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('opens from the actual Topic Files tree without changing Category or borrowing a Work occurrence', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  installFileTreeGeometry()
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([{ name: 'notes.md', path, isDirectory: false, isSymlink: false }])
  const container = document.createElement('div'); document.body.append(container)
  const root = createClientUiRoot(container)
  try {
    await act(async () => { root.render(createElement(FileExplorer, { workspaceId: workspace.id, rootPath: topics[1]!.directoryPath })); await new Promise(resolve => setTimeout(resolve, 50)) })
    const row = container.querySelector<HTMLElement>(`[data-tree-path="${path}"]`)
    expect(row, container.textContent ?? '').not.toBeNull()
    await act(async () => { row!.click(); await new Promise(resolve => setTimeout(resolve, 20)) })
    const state = useAppStore.getState(), selected = state.workbenchSpaceSelection!
    expect(selected).toMatchObject({ topicId: topics[1]!.id, zoneId: zones[1], spaceId: 'category-1' })
    expect(state.tabs[selected.tabId!]!.regions[selected.regionId!]).toMatchObject({ kind: 'file', workspaceId: workspace.id, path })
    expect(state.tabs[tabs[0]!.id]).toBe(tabs[0])
    expect(api.files.read).toHaveBeenCalledExactlyOnceWith(workspace.id, path)
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('opens a distinct Study File occurrence while retaining Work and the shared dirty Document', async () => {
  const retained = { ...createWorkbenchTab('retained-file', { kind: 'file' as const, regionId: 'retained-region', workspaceId: workspace.id, path }),
    topicId: topics[0]!.id, space: { spaceId: contentSpaces[0]!, zoneId: zones[0]! } }
  const layout = activateTab(createWorkspaceLayout('group', [...tabs.map(tab => tab.id), retained.id]), 'group', tabs[1]!.id)
  useAppStore.setState(state => ({ tabs: { ...state.tabs, [retained.id]: retained }, layouts: { [workspace.id]: layout },
    documents: { [documentKey(workspace.id, path)]: { path, content: 'STUDY FILE', revision: 'original' } },
    dirtyDocuments: { [documentKey(workspace.id, path)]: true } }))
  const originalDocument = useAppStore.getState().documents[documentKey(workspace.id, path)]
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject(selection(1))
  expect(useAppStore.getState().layouts[workspace.id]!.groups[0]!.activeTabId).toBe(tabs[1]!.id)
  await useAppStore.getState().openFileAndReveal(path, undefined, undefined, workspace.id)
  const after = useAppStore.getState()
  expect(after.workbenchSpaceSelection).toMatchObject({ topicId: topics[1]!.id, spaceId: 'category-1', zoneId: zones[1] })
  expect(after.workbenchSpaceSelection?.tabId).not.toBe(retained.id)
  expect(after.tabs[retained.id]).toBe(retained)
  expect(after.documents[documentKey(workspace.id, path)]?.content).toBe('STUDY FILE')
  expect(after.documents[documentKey(workspace.id, path)]).toBe(originalDocument)
  expect(after.dirtyDocuments[documentKey(workspace.id, path)]).toBe(true)
  expect(api.files.read).not.toHaveBeenCalled()
})

it('gives simultaneous callers in different Topics separate occurrences of one shared read', async () => {
  let finish!: (value: Awaited<ReturnType<typeof api.files.read>>) => void
  vi.mocked(api.files.read).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  useAppStore.setState({ workbenchSpaceSelection: selection(0) })
  const work = useAppStore.getState().openFile(path, undefined, undefined, workspace.id)
  await vi.waitFor(() => expect(api.files.read).toHaveBeenCalledOnce())
  useAppStore.setState({ workbenchSpaceSelection: selection(1) })
  const study = useAppStore.getState().openFile(path, undefined, undefined, workspace.id)
  finish({ status: 'read', document: { path, content: 'ONE READ', revision: 'original' } })
  await Promise.all([work, study])
  const state = useAppStore.getState()
  expect(state.workbenchSpaceSelection).toMatchObject({ topicId: topics[1]!.id, zoneId: zones[1] })
  const files = Object.values(state.tabs).filter(tab => Object.values(tab.regions).some(surface => surface.kind === 'file' && surface.path === path))
  expect(files.map(tab => tab.space?.zoneId).sort()).toEqual([...zones].sort())
  expect(state.documents[documentKey(workspace.id, path)]?.content).toBe('ONE READ')
  expect(api.files.read).toHaveBeenCalledOnce()
})

it('keeps later Topic navigation while an earlier file read completes', async () => {
  let finish!: (value: Awaited<ReturnType<typeof api.files.read>>) => void
  vi.mocked(api.files.read).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const opening = useAppStore.getState().openFileAndReveal(path, undefined, undefined, workspace.id)
  await vi.waitFor(() => expect(api.files.read).toHaveBeenCalledOnce())
  const later = selection(0)
  useAppStore.setState({ workbenchSpaceSelection: later })
  finish({ status: 'read', document: { path, content: 'PRESERVED', revision: 'original' } })
  expect(await opening).toBe(false)
  const state = useAppStore.getState()
  expect(state.workbenchSpaceSelection).toBe(later)
  expect(state.tabs[tabs[0]!.id]).toBe(tabs[0])
  expect(state.documents[documentKey(workspace.id, path)]?.content).toBe('PRESERVED')
})

it.each(['image.png', 'paper.pdf'])('opens %s in the selected Topic without UTF-8 reads', async name => {
  const filePath = 'topic--view--study/' + name
  expect(await useAppStore.getState().openFileAndReveal(filePath, undefined, undefined, workspace.id)).toBe(true)
  const state = useAppStore.getState(), tab = state.tabs[state.workbenchSpaceSelection!.tabId!]!
  expect(tab.space?.zoneId).toBe(zones[1])
  expect(state.workbenchSpaceSelection?.spaceId).toBe('category-1')
  expect(api.files.read).not.toHaveBeenCalled()
})

it('keeps ordinary Folder files available across successive opens', async () => {
  const resource = composerConfig.workspaces[0]!
  useAppStore.setState({ config: composerConfig, activeWorkspaceId: resource.id, workbenchSpaceSelection: null,
    tabs: {}, layouts: { [resource.id]: createWorkspaceLayout('folder-group') }, spaceZoneBindings: {} })
  for (const filePath of ['photo.png', 'music.mp3', 'film.mp4', 'document.pdf', 'photo.png']) {
    const opened = await useAppStore.getState().openFile(filePath, 'folder-group', undefined, resource.id)
    expect(opened, JSON.stringify(useAppStore.getState().error)).toBe(true)
    expect(useAppStore.getState().workbenchSpaceSelection?.workspaceId).toBe(resource.id)
  }
})

it('opens an empty Study Topic file in its own Zone despite a background Work Tab', async () => {
  useAppStore.setState(state => ({ tabs: { [tabs[0]!.id]: tabs[0]! }, layouts: { [workspace.id]: createWorkspaceLayout('group', [tabs[0]!.id]) },
    workbenchSpaceSelection: { ...selection(1), tabId: null, regionId: null, groupId: null } }))
  await useAppStore.getState().openFileAndReveal(path, undefined, undefined, workspace.id)
  const after = useAppStore.getState()
  expect(after.workbenchSpaceSelection).toMatchObject({ topicId: topics[1]!.id, spaceId: 'category-1', zoneId: zones[1] })
})

it('keeps Recall source opening local to its Zone and preserves the original Work selection', async () => {
  const originalWork = selection(0)
  useAppStore.setState({ mainSurface: 'recall', workbenchSpaceSelection: originalWork, recallZoneSelection: { zoneId: zones[1]!, selection: [{ tabId: tabs[1]!.id, regionId: 'region-1' }], active: { tabId: tabs[1]!.id, regionId: 'region-1' } } })
  const { openKnowledgeSource } = await import('../src/renderer/src/lib/topic-knowledge-actions')
  await openKnowledgeSource({ kind: 'file', hostId: 'local', path: topics[1]!.physicalDirectoryPath + '/notes.md' })
  const after = useAppStore.getState()
  expect(after.mainSurface).toBe('recall')
  expect(after.workbenchSpaceSelection).toBe(originalWork)
  expect(after.recallZoneSelection?.zoneId).toBe(zones[1])
  const fileTab = after.tabs[after.recallZoneSelection!.active!.tabId]!
  expect(fileTab.space?.zoneId).toBe(zones[1])
  expect(Object.values(fileTab.regions)).toContainEqual(expect.objectContaining({ kind: 'file', path }))
})

it('opens an explicit cross-Workspace source locally without making the old Recall Zone a resource gate', async () => {
  const other = { ...composerConfig.workspaces[0]!, id: 'source-project', path: '/fixture/source-project' }
  const originalWork = selection(0)
  useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [workspace, other] },
    layouts: { ...state.layouts, [other.id]: createWorkspaceLayout('source-group') }, mainSurface: 'recall', workbenchSpaceSelection: originalWork,
    recallZoneSelection: { zoneId: zones[1]!, selection: [], active: null } }))
  const { openKnowledgeSource } = await import('../src/renderer/src/lib/topic-knowledge-actions')
  await openKnowledgeSource({ kind: 'file', hostId: 'local', path: other.path + '/source.md' })
  const state = useAppStore.getState()
  expect(api.files.read).toHaveBeenCalledExactlyOnceWith(other.id, 'source.md')
  expect(state.mainSurface).toBe('recall')
  expect(state.workbenchSpaceSelection).toBe(originalWork)
  const active = state.recallZoneSelection!.active!
  expect(state.tabs[active.tabId]!.regions[active.regionId]).toMatchObject({ kind: 'file', workspaceId: other.id, path: 'source.md' })
})

it('keeps Survey source selection separate from Work', async () => {
  const originalWork = selection(0)
  useAppStore.setState({ mainSurface: 'survey', workbenchSpaceSelection: originalWork,
    surveyZoneSelection: { zoneId: zones[1]!, selection: [], active: null } })
  expect(await useAppStore.getState().openFileAndReveal(path, undefined, undefined, workspace.id)).toBe(true)
  const state = useAppStore.getState()
  expect(state.workbenchSpaceSelection).toBe(originalWork)
  expect(state.mainSurface).toBe('survey')
  const active = state.surveyZoneSelection!.active!
  expect(state.tabs[active.tabId]!.space?.zoneId).toBe(zones[1])
})

it('opens a bookmark as a Browser in the same Topic while preserving its source identity', async () => {
  const bookmarkPath = topics[1]!.directoryPath + '/source.webloc'
  vi.spyOn(api.files, 'readBookmark').mockResolvedValue({ url: 'https://example.test/original', binary: false })
  vi.spyOn(api.browser, 'create').mockImplementation(async (id, url) => ({ id, url: url!, title: 'Original page', loading: false, canGoBack: false, canGoForward: false }))
  expect(await useAppStore.getState().openFileAndReveal(bookmarkPath, undefined, undefined, workspace.id)).toBe(true)
  const state = useAppStore.getState(), choice = state.workbenchSpaceSelection!
  expect(choice).toMatchObject({ spaceId: 'category-1', topicId: topics[1]!.id, zoneId: zones[1] })
  expect(state.tabs[choice.tabId!]!.regions[choice.regionId!]).toMatchObject({ kind: 'browser', workspaceId: workspace.id,
    url: 'https://example.test/original', bookmarkOrigin: { path: bookmarkPath } })
  expect(state.tabs[tabs[0]!.id]).toBe(tabs[0])
  expect(api.files.read).not.toHaveBeenCalled()
})

it('does not make DOM presentation observation a prerequisite for file navigation', async () => {
  const query = document.querySelectorAll.bind(document)
  vi.spyOn(document, 'querySelectorAll').mockImplementation((selector: string) => {
    if (selector.startsWith('[data-workbench-region-id=')) throw new Error('Private presentation probe unavailable')
    return query(selector)
  })
  expect(await useAppStore.getState().openFileAndReveal(path, undefined, undefined, workspace.id)).toBe(true)
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ spaceId: 'category-1', topicId: topics[1]!.id, zoneId: zones[1] })
})

it('keeps background public opens in their exact Topic while retaining an older foreign File occurrence', async () => {
  const retained = { ...createWorkbenchTab('legacy-work-file', { kind: 'file', regionId: 'legacy-region', workspaceId: workspace.id, path }), topicId: topics[0]!.id }
  const originalChoice = selection(0)
  useAppStore.setState(state => ({ tabs: { ...state.tabs, [retained.id]: retained },
    layouts: { [workspace.id]: createWorkspaceLayout('group', [...tabs.map(tab => tab.id), retained.id]) },
    workbenchSpaceSelection: originalChoice, documents: { [documentKey(workspace.id, path)]: { path, content: 'SAVED SOURCE', revision: 'original' } } }))
  const stateBefore = useAppStore.getState()
  const report = await executeWorkfaceFileOpen({ get: () => useAppStore.getState(), navigationSelection: () => '', topics: async () => topics,
    openFile: (...args) => useAppStore.getState().openFile(...args), closing: () => false,
    save: async () => ({ layoutApplied: true, localStorageWritten: true, storageFlushRequested: true, diskDurability: 'confirmed', reason: null }) },
    { operation: 'open.file', zoneId: zones[1]!, spaceId: 'category-1', path: 'notes.md', focus: false })
  expect(report, JSON.stringify(report)).toMatchObject({ outcome: 'opened', data: { kind: 'text' }, navigation: 'background' })
  const after = useAppStore.getState()
  expect(after.tabs[retained.id]).toBe(retained)
  expect(after.workbenchSpaceSelection).toBe(originalChoice)
  expect(after.tabs[report.placement.tabId!]!.space?.zoneId).toBe(zones[1])
  expect(after.documents).toBe(stateBefore.documents)
})

it.each(['same-tab', 'peer-tab'])('reopens an exact healthy %s File while its Category relationship remains unknown', async position => {
  const tab = { ...createWorkbenchTab('known-file', { kind: 'file', regionId: 'known-file-region', workspaceId: workspace.id, path }),
    topicId: topics[1]!.id, space: { spaceId: contentSpaces[1]!, zoneId: zones[1]! } }
  const original = position === 'same-tab' ? selection(1, tab.id, 'known-file-region') : selection(1)
  useAppStore.setState(state => ({ tabs: { ...state.tabs, [tab.id]: tab },
    layouts: { [workspace.id]: createWorkspaceLayout('group', [...tabs.map(tab => tab.id), tab.id]) }, workbenchSpaceSelection: original,
    documents: { [documentKey(workspace.id, path)]: { path, content: 'PRESERVED SOURCE', revision: 'original' } },
    spaceZoneBindings: { ...state.spaceZoneBindings, [zones[1]!]: { ...state.spaceZoneBindings[zones[1]!]!,
      relations: { 'category-1': false, 'category-0': true, 'unavailable-category': true } } } }))
  expect(await useAppStore.getState().openFileAndReveal(path, undefined, undefined, workspace.id)).toBe(true)
  const state = useAppStore.getState()
  expect(state.workbenchSpaceSelection).toMatchObject({ ...original, tabId: tab.id, regionId: 'known-file-region' })
  expect(state.tabs[tab.id]).toBe(tab)
  expect(state.documents[documentKey(workspace.id, path)]?.content).toBe('PRESERVED SOURCE')
  expect(api.files.read).not.toHaveBeenCalled()
})

it('keeps a late A diff on its original A File while the current B Region remains selected', async () => {
  const a = { ...composerConfig.workspaces[0]!, id: 'a', path: '/fixture/a' }
  const b = { ...a, id: 'b', path: '/fixture/b' }
  const path = 'same.ts'
  const atab = createWorkbenchTab('a-tab', { kind: 'launcher', workspaceId: a.id, regionId: 'a-region' })
  const btab = createWorkbenchTab('b-tab', { kind: 'file', workspaceId: b.id, path, regionId: 'b-region' })
  const choice = (id: string) => ({ spaceId: null, zoneId: null, workspaceId: id, topicId: null,
    tabId: id + '-tab', groupId: id + '-group', regionId: id + '-region' })
  useAppStore.setState({ config: { ...composerConfig, workspaces: [a,b] }, activeWorkspaceId: a.id, mainSurface: 'workbench',
    tabs: { [atab.id]: atab, [btab.id]: btab }, layouts: { a: createWorkspaceLayout('a-group',[atab.id]), b: createWorkspaceLayout('b-group',[btab.id]) },
    workbenchSpaceSelection: choice('a'), documents: { [documentKey(b.id,path)]: {path,content:'B original',revision:'b'} },
    documentIssues:{}, dirtyDocuments:{}, documentGenerations:{}, documentObservationGenerations:{}, sessions:[], spaceZoneBindings:{} })
  let finish!: (value: Awaited<ReturnType<typeof api.files.read>>) => void
  vi.spyOn(api.files,'observe').mockResolvedValue(undefined)
  vi.spyOn(api.files,'unobserve').mockResolvedValue(undefined)
  vi.spyOn(api.files,'read').mockImplementation(() => new Promise(resolve => {finish=resolve}))
  const apply = vi.spyOn(useAppStore.getState(),'setEditorRegionMode').mockResolvedValue(undefined)
  const opening = useAppStore.getState().openFileDiff(path,a.id)
  await vi.waitFor(() => expect(api.files.read).toHaveBeenCalledOnce())
  const later = choice('b')
  useAppStore.setState({ activeWorkspaceId:b.id, workbenchSpaceSelection:later })
  finish({status:'read',document:{path,content:'A data',revision:'a'}})
  await opening
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(later)
  expect(apply).toHaveBeenCalledOnce()
  const [region,workspaceId,filePath,mode]=apply.mock.calls[0]!
  expect(region).not.toBe('b-region')
  expect([workspaceId,filePath,mode]).toEqual(['a',path,'diff'])
  const destination=Object.values(useAppStore.getState().tabs).flatMap(tab=>Object.values(tab.regions)).find(surface=>surface.regionId===region)
  expect(destination).toMatchObject({kind:'file',workspaceId:'a',path})
})


it('selects the exact existing File Region rather than its old active sibling', async () => {
  const workspace = composerConfig.workspaces[0]!, path = 'notes.md'
  const spaceId = directoryIdentity(workspace.hostId,workspace.path), zoneId = workspaceZoneId(spaceId,workspace.id)
  const before = addWorkbenchRegion(createWorkbenchTab('mixed-tab', {kind:'launcher',workspaceId:workspace.id,regionId:'agent-side'}),
    'agent-side','right',{kind:'file',workspaceId:workspace.id,path,regionId:'file-side'})
  const tab = {...before, space:{spaceId,zoneId}, layout:{...before.layout,activeRegionId:'agent-side'}}
  const choice = {spaceId,zoneId,workspaceId:workspace.id,topicId:null,tabId:tab.id,groupId:'group',regionId:'agent-side'}
  useAppStore.setState({config:composerConfig,activeWorkspaceId:workspace.id,mainSurface:'workbench',
    tabs:{[tab.id]:tab},layouts:{[workspace.id]:createWorkspaceLayout('group',[tab.id])},workbenchSpaceSelection:choice,
    documents:{[documentKey(workspace.id,path)]:{path,content:'Original note',revision:'original'}},documentIssues:{},dirtyDocuments:{},
    sessions:[],spaceZoneBindings:{},scratchTopicSnapshots:{}})
  const opened=await useAppStore.getState().openFileAndReveal(path,undefined,undefined,workspace.id)
  expect(opened).toBe(true)
  expect(useAppStore.getState().workbenchSpaceSelection?.regionId).toBe('file-side')
})

it('honors an exact destination Group when the source origin has a reusable File in another Group', () => {
  const workspace=composerConfig.workspaces[0]!,path='same.md'
  const spaceId=directoryIdentity(workspace.hostId,workspace.path),zoneId=workspaceZoneId(spaceId,workspace.id)
  const tab={...createWorkbenchTab('original-file',{kind:'file',workspaceId:workspace.id,path,regionId:'original-region'}),space:{spaceId,zoneId}}
  const first=createWorkspaceLayout('left',[tab.id])
  const layout={...first,root:{type:'split' as const,direction:'horizontal' as const,ratio:.5,first:first.root,second:{type:'leaf' as const,groupId:'right'}},
    groups:[...first.groups,{...first.groups[0]!,id:'right',tabOrder:[],activeTabId:null,recentTabIds:[]}]}
  useAppStore.setState({config:composerConfig,sessions:[],tabs:{[tab.id]:tab},layouts:{[workspace.id]:layout},spaceZoneBindings:{},scratchTopicSnapshots:{}})
  const state=useAppStore.getState(),catalog=spatialCatalog(state, [])
  const resolved=resolveFileOpenTarget(state,[],catalog,workspace.id,path,{zoneId,newTab:true,displayWorkspaceId:workspace.id,groupId:'right'},
    {displayWorkspaceId:workspace.id,groupId:'left',tabId:tab.id,regionId:'original-region'})
  expect(resolved.address.groupId).toBe('right')
})
