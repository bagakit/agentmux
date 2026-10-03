import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { createWorkspaceLayout } from '@agentmux/layout'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { WindowOverlayHost } from '../../../src/renderer/src/components/WindowOverlayHost'
import { WorkspaceFilesTool } from '../../../src/renderer/src/components/SurfaceToolDock'
import { FileSurfaceView } from '../../../src/renderer/src/components/FileSurfaceView'
import { NewTabSurface } from '../../../src/renderer/src/components/NewTabSurface'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { scratchTopicsScope } from '../../../src/renderer/src/lib/scratch-topic-snapshots'
import { useMoteMaterialsActions } from '../../../src/renderer/src/lib/mote-materials-actions'
import { useMoteWorkfaceScope } from '../../../src/renderer/src/lib/mote-workface'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID, scratchTopicDirectoryName } from '../../../src/shared/scratch-topics'
import { directoryIdentity, homeZoneId } from '../../../src/shared/space-addresses'
import '../../../src/renderer/src/styles/index.css'

const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: _hygiene_fixturePath("fixture/topics"), name: 'Motes', kind: 'folder' as const }
const folder = scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID), soul = '# Mote\n\nWork with me as a thoughtful colleague.\n'
const topic = { id: PMO_TEAMS_TOPIC_ID, title: 'Mote', summary: 'A thoughtful partner for your next idea.', collaborators: [],
  directoryPath: workspace.path + '/' + folder, topicPath: workspace.path + '/' + folder + '/topic.md',
  soul: { path: workspace.path + '/' + folder + '/SOUL.md', content: soul, version: 'fixture-soul' } }
const spaceId = directoryIdentity('local', topic.directoryPath), zoneId = homeZoneId(spaceId)
const tab = { ...createWorkbenchTab('original-tab', { kind: 'launcher', regionId: 'original-region', workspaceId: workspace.id }), topicId: topic.id, space: { spaceId, zoneId } }
const calls: { operation: string; path?: string }[] = []
const content = { [folder + '/SOUL.md']: soul, [folder + '/next-small-experiment.md']: '# Next small experiment\n\nTry the simplest useful version first.\n' }
const revision = 'sha256:' + 'a'.repeat(64)
api.scratch.listTopics = async () => [topic]; api.scratch.readTopic = async () => topic; api.scratch.ensureMote = async () => topic
api.files.readDirectory = async (_workspace, path) => {
  calls.push({ operation: 'readDirectory', path })
  return Object.keys(content).filter(file => file.startsWith(path + '/')).map(file => ({ path: file, name: file.split('/').at(-1)!, isDirectory: false, isSymlink: false, ignored: false, mtimeMs: 20 }))
}
api.files.read = async (_workspace, path) => ({ status: 'read', document: { path, content: content[path] ?? '', revision } })
api.files.readPublic = async params => {
  const path = folder + '/' + params.path
  return { resource: { ...params.expectedResource, zoneId, zonePath: topic.directoryPath, path }, result: { status: 'read', document: { path, content: content[path] ?? '', revision } } }
}
api.files.observe = async () => {}; api.files.unobserve = async () => {}; api.files.onInvalidated = () => () => {}
api.files.write = async (_workspace, input) => { calls.push({ operation: 'write', path: input.path }); throw new Error('No save is authorized in this capture') }
useAppStore.setState({ config: { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }], workspaces: [workspace], executors: {},
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } },
  sessions: [], tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('original-group', [tab.id]) }, loading: false,
  activeWorkspaceId: workspace.id, mainSurface: 'workbench', explorerCollapsed: { [workspace.id]: false },
  scratchTopicSnapshots: { [workspace.id]: { scope: scratchTopicsScope(workspace), revision: 0, topics: [topic], reading: false, error: null } },
  workbenchSpaceSelection: { workspaceId: workspace.id, groupId: 'original-group', tabId: tab.id, regionId: 'original-region', topicId: topic.id, spaceId, zoneId },
  agentComposerDrafts: { 'original-region': 'Keep this original unsent question.' }, detectExecutors: async () => {}, prewarmTerminal: async () => {} })
function Scene() {
  const scope = useMoteWorkfaceScope(workspace.id)!, materials = useMoteMaterialsActions(scope)
  const selected = useAppStore(state => state.workbenchSpaceSelection), selectedTab = useAppStore(state => selected?.tabId ? state.tabs[selected.tabId] : tab)
  const region = selectedTab?.regions[selected?.regionId ?? 'original-region']
  const [narrow, setNarrow] = useState(false)
  Object.assign(window, { moteHeader: { narrow: setNarrow, theme: (light: boolean) => { document.documentElement.dataset.appearance = light ? 'light' : 'dark' },
    facts: () => ({ calls, drafts: useAppStore.getState().agentComposerDrafts }) } })
  return <DesktopClientUiProvider><WindowOverlayHost /><main style={{ display: 'flex', height: '100vh', background: 'var(--bg)', color: 'var(--text)' }}>
    <aside style={{ width: narrow ? '100%' : 300, flexShrink: 0, minWidth: 0, borderRight: '1px solid var(--line-soft)' }}>
      <WorkspaceFilesTool workspace={workspace} isScratch visible topicId={topic.id} onOpenPath={materials.open} onOpenTerminal={materials.terminal} />
    </aside>
    {!narrow ? <section className="workbench-region" style={{ flex: 1, minWidth: 0 }}>
      {selectedTab && region?.kind === 'file' ? <FileSurfaceView tabId={selectedTab.id} surface={region} /> : <NewTabSurface tabId={tab.id} regionId="original-region" tabGroupId="original-group" />}
    </section> : null}
  </main></DesktopClientUiProvider>
}
createRoot(document.getElementById('root')!).render(<Scene />)
