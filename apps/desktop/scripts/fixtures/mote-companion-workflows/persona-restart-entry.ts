import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
const owner = new AgentMuxSpatialStateStore(join(directory!, 'spatial-state.json'))
api.config.get = async () => input.config
api.spatial.read = () => owner.read()
api.spatial.commit = value => owner.commit(value)
api.spatial.onChange = callback => owner.subscribe(callback)
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
  await prepareRendererUpdate('reload')
}
const current = useAppStore.getState()
writeFileSync(join(directory!, mode + '-output.json'), JSON.stringify({ pid: process.pid, fileWrites, tabs: current.tabs, layouts: current.layouts,
  selection: current.workbenchSpaceSelection, agentComposerDrafts: current.agentComposerDrafts,
  launcherState: useLauncherState.persist.getOptions().partialize!(useLauncherState.getState()),
  spatial: await owner.read(), savedWorkbench: JSON.parse(readFileSync(join(directory!, 'agentmux-workbench-v1.json'), 'utf8')),
  savedLauncher: existsSync(join(directory!, 'agentmux-launcher.json')) ? JSON.parse(readFileSync(join(directory!, 'agentmux-launcher.json'), 'utf8')) : null,
  warning: current.workbenchSaveWarning, launcherIssue: useLauncherState.getState().persistenceIssue }))
dispose()
process.exit(0)
