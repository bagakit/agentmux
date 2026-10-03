import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { AgentMuxSpatialStateStore } from '../../../../../packages/core/src/spatial-state'

const [mode, directory, inputFile] = process.argv.slice(2)
const input = JSON.parse(readFileSync(inputFile!, 'utf8'))
const events = new EventTarget()
Object.assign(globalThis, { window: {
  localStorage: {
    getItem: (key: string) => existsSync(join(directory!, key + '.json')) ? readFileSync(join(directory!, key + '.json'), 'utf8') : null,
    setItem: (key: string, value: string) => writeFileSync(join(directory!, key + '.json'), value),
    removeItem: () => { throw new Error('This readback probe never removes a durable record') }
  },
  addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events)
} })
const { api } = await import('../../../src/renderer/src/lib/api')
const { useAppStore, prepareRendererUpdate } = await import('../../../src/renderer/src/store')
const { useLauncherState } = await import('../../../src/renderer/src/lib/launcher-state')
const { desktopSpatialGraph } = await import('../../../src/renderer/src/lib/desktop-spatial-state')
const { documentKey } = await import('../../../src/renderer/src/lib/workbench-tabs')
const { parseMoteBehaviorBlock } = await import('../../../src/renderer/src/lib/mote-behavior')
const owner = new AgentMuxSpatialStateStore(join(directory!, 'spatial-state.json'))
api.config.get = async () => input.config
api.spatial.read = () => owner.readForLayout()
api.spatial.commit = value => owner.commit(value)
api.spatial.onChange = callback => owner.subscribe(callback)
api.spatial.retainLabels = values => owner.retainDisplayLabels(values)
const originalSnapshot = await api.sessions.snapshot()
api.sessions.snapshot = async () => ({ ...originalSnapshot, sessions: [], recoveryCandidates: [] })
api.scratch.listTopics = async () => input.topics
api.scratch.ensureMote = async () => input.topics[0]
api.scratch.readTopic = async (_workspace, id) => input.topics.find((topic: { id: string }) => topic.id === id)
api.files.observe = async () => {}
api.files.unobserve = async () => {}
api.ui.requestStorageFlush = async () => {}
let fileWrites = 0
api.files.write = async () => { fileWrites++; throw new Error('No file write is authorized by this input readback probe') }
let originalFiles: import('../../../src/main/workspace-files').WorkspaceFiles | undefined
let behavior: unknown
if (input.behavior) {
  const workspace = input.config.workspaces.find((item: { id: string }) => item.id === input.selection.workspaceId)
  assert.equal(workspace.hostId, 'local')
  const file = resolve(workspace.path, input.behavior.path)
  // The original Renderer supplies this private process's exact resource. Never remap a real user root.
  assert.ok(relative(resolve(input.privateRoot), file).length > 0 && !relative(resolve(input.privateRoot), file).startsWith('..'))
  if (mode === 'write') { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, input.behavior.initialContent) }
  const { WorkspaceFiles } = await import('../../../src/main/workspace-files')
  originalFiles = new WorkspaceFiles(id => ({ id, kind: 'local', label: 'Private fixture',
    run: async () => { throw new Error('This original File readback never launches a Run') }, dispose: async () => {} }))
  api.files.read = async (workspaceId, path) => { assert.equal(workspaceId, workspace.id); return originalFiles!.read(workspace, path) }
  api.files.write = async (workspaceId, value) => { assert.equal(workspaceId, workspace.id); assert.equal(value.path, input.behavior.path); fileWrites++; return originalFiles!.write(workspace, value) }
}

if (mode === 'write') {
  await owner.commit({ expectedRevision: 0, graph: desktopSpatialGraph({ ...input, sessions: [] }, input.topics) })
}
const dispose = await useAppStore.getState().initialize()
if (mode === 'write') {
  useAppStore.setState({ workbenchSpaceSelection: input.selection, mainSurface: 'workbench' })
  for (const [regionId, prompt] of Object.entries(input.agentComposerDrafts)) useAppStore.getState().setAgentComposerDraft(regionId, prompt as string)
  // Consume the original durable input setters; the fixture does not serialize a second draft owner.
  for (const [key, draft] of Object.entries(input.launcherState.drafts) as [string, any][]) {
    for (const field of ['browser', 'note', 'prompt'] as const) if (typeof draft[field] === 'string') useLauncherState.getState().setDraft(key, field, draft[field])
    if (draft.moteIdea) useLauncherState.getState().setMoteIdeaDraft(key, draft.moteIdea)
  }
  for (const [workspaceId, sections] of Object.entries(input.launcherState.sections) as [string, any][]) {
    for (const [section, value] of Object.entries(sections) as [any, any][]) useLauncherState.getState().setSection(workspaceId, section, value)
  }
  for (const [workspaceId, executorId] of Object.entries(input.launcherState.executors)) useLauncherState.getState().selectExecutor(workspaceId, executorId as string)
  if (input.launcherState.moteTopicId) useLauncherState.getState().selectMote(input.launcherState.moteTopicId)
  if (input.behavior) {
    const selected = input.selection, tab = useAppStore.getState().tabs[selected.tabId], region = tab?.regions[selected.regionId]
    assert.equal(region?.kind, 'file'); assert.equal(region.path, input.behavior.path)
    await useAppStore.getState().attachPersistedFileDocument(region.workspaceId, region.path)
    const key = documentKey(region.workspaceId, region.path)
    assert.equal(useAppStore.getState().documents[key]?.content, input.behavior.initialContent)
    useAppStore.getState().updateDocument(tab.id, input.behavior.content, region.regionId)
    await useAppStore.getState().saveDocument(tab.id, region.regionId)
    assert.notEqual(useAppStore.getState().dirtyDocuments[key], true)
    assert.equal(useAppStore.getState().documentIssues[key], undefined)
  }
  await prepareRendererUpdate('reload')
}
if (input.behavior) {
  const workspace = input.config.workspaces.find((item: { id: string }) => item.id === input.selection.workspaceId)
  const read = await originalFiles!.read(workspace, input.behavior.path)
  assert.equal(read.status, 'read')
  if (read.status !== 'read') throw new Error('The original saved file readback is unconfirmed')
  assert.equal(read.document.content, input.behavior.content)
  const block = parseMoteBehaviorBlock(read.document.content)
  assert.equal(block.status, 'valid')
  behavior = { document: read.document, block }
}
const current = useAppStore.getState()
writeFileSync(join(directory!, mode + '-output.json'), JSON.stringify({ pid: process.pid, fileWrites, behavior, tabs: current.tabs, layouts: current.layouts,
  selection: current.workbenchSpaceSelection, agentComposerDrafts: current.agentComposerDrafts,
  launcherState: useLauncherState.persist.getOptions().partialize!(useLauncherState.getState()),
  spatial: await owner.read(), savedWorkbench: JSON.parse(readFileSync(join(directory!, 'agentmux-workbench-v1.json'), 'utf8')),
  savedLauncher: existsSync(join(directory!, 'agentmux-launcher.json')) ? JSON.parse(readFileSync(join(directory!, 'agentmux-launcher.json'), 'utf8')) : null,
  warning: current.workbenchSaveWarning, launcherIssue: useLauncherState.getState().persistenceIssue }))
dispose()
await originalFiles?.dispose()
process.exit(0)
