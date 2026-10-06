import { createRoot } from 'react-dom/client'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { flushSync } from 'react-dom'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { FileExplorer } from '../../../src/renderer/src/components/FileExplorer'
import { WindowOverlayHost } from '../../../src/renderer/src/components/WindowOverlayHost'
import { GlobalSystemNotices } from '../../../src/renderer/src/components/GlobalSystemNotices'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { addWorkbenchRegion, createWorkbenchTab, documentKey, fileTabId } from '../../../src/renderer/src/lib/workbench-tabs'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import { useNativeOverlayChrome } from '../../../src/renderer/src/hooks/useNativeOverlayChrome'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import '../../../src/renderer/src/styles/index.css'

const boot = (window as any).previewFixtureBoot
if (!boot || !window.agentmux) throw new Error('Private native preload facts are required')
const workspaceId = boot.config.workspaces[0].id
const storedBeforeInitialize = boot.phase === 'restart' ? JSON.parse(localStorage.getItem('agentmux-workbench-v1') ?? 'null')?.state : null
// Only configuration, discovery and this original conversation's messages are controlled facts.
api.config = { ...api.config, get: async () => structuredClone(boot.config), save: async config => structuredClone(config) }
api.sessions = { ...api.sessions, snapshot: async () => ({ sessions: [], timelines: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [], environmentWarning: null }),
  historyPage: async () => ({ agentSessionId: 'preview-conversation', source: { providerId: 'codex', nativeSessionId: 'controlled' }, items: [], nextCursor: null }),
  launchTerminal: async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); throw new Error('Private preview proof does not launch a Run') } }
api.providers = { ...api.providers, list: async () => [] }; api.demands = { ...api.demands, list: async () => [] }
await useAppStore.getState().initialize()
useAppStore.setState({ toolsOpen: false, localHome: boot.home })
const durable = () => { const state = useAppStore.getState(); return { ...projectPersistedWorkbench(state), activeWorkspaceId: state.activeWorkspaceId,
  documents: structuredClone(state.documents), dirtyDocuments: structuredClone(state.dirtyDocuments), agentComposerDrafts: structuredClone(state.agentComposerDrafts) } }
const beforeFixture = boot.phase === 'restart' ? durable() : null
if (boot.phase === 'capture') {
  await useAppStore.getState().openFile('notes.md', undefined, undefined, workspaceId)
  await useAppStore.getState().openFile('docs/readme.md', undefined, undefined, workspaceId)
}
const root = createRoot(document.getElementById('root')!)
let messageProjection: { content: string; ratio: number } | null = null
const readImage = (path: string) => api.ui.readPastedImage(path)
function Shell() {
  const warning = useNativeOverlayChrome()
  return <><aside id="fixture-tree"><FileExplorer /></aside><div id="fixture-center" data-chrome-warning={warning}>
    {messageProjection ? <section id="fixture-conversation" className="activity-feed" style={{ flex: '0 0 260px', minHeight: 0, overflow: 'auto' }}>
      <div data-message-width style={{ width: `calc((100% - 24px) * ${messageProjection.ratio})`, minWidth: 0, padding: 12 }}>
        <ConversationMessage messageId="original-image-message" conversationSessionId="recorded-author" speaker={{ role: 'agent', id: 'recorded-author' }} name="Preview conversation"
          content={messageProjection.content} status="complete" createdAt={1} workspaceRoot={boot.config.workspaces[0].path} homeDir={boot.home} readPastedImage={readImage} />
      </div></section> : null}
    <div id="fixture-workbench"><WorkspaceWorkbench workspaceId={workspaceId} /></div></div>
    <footer className="window-status-bar" style={{ position: 'fixed', left: 0, right: 0, bottom: 0 }}><GlobalSystemNotices nativeOverlayWarning={warning} /></footer><WindowOverlayHost /></>
}
flushSync(() => root.render(<DesktopClientUiProvider><Shell /></DesktopClientUiProvider>))
const sourceTabId = fileTabId(workspaceId, 'docs/readme.md')
const source = () => useAppStore.getState().tabs[sourceTabId]!
const probe = {
  workspaceId, sourceTabId, beforeFixture, storedBeforeInitialize, durable,
  facts() { const state = useAppStore.getState(); return { ...durable(), error: state.error, surfaces: Object.values(state.tabs).flatMap(tab => Object.values(tab.regions)) } },
  async source(ratio = .62) {
    await useAppStore.getState().openFile('docs/readme.md', undefined, undefined, workspaceId)
    const state = useAppStore.getState(), tab = source(), region = Object.values(tab.regions).find(surface => surface.kind === 'file' && surface.path === 'docs/readme.md')!
    const neighborId = 'original-neighbor'
    let next = tab.regions[neighborId] ? tab : addWorkbenchRegion(tab, region.regionId, 'right', { regionId: neighborId, kind: 'file', workspaceId, path: 'notes.md' })
    if (next.layout.root.type === 'split') next = { ...next, layout: { ...next.layout, root: { ...next.layout.root, ratio }, activeRegionId: region.regionId } }
    flushSync(() => useAppStore.setState({ tabs: { ...state.tabs, [tab.id]: next } }))
    await state.setEditorRegionMode(region.regionId, workspaceId, 'docs/readme.md', 'preview')
  },
  dirtySource() { const tab = source(), region = Object.values(tab.regions).find(surface => surface.kind === 'file' && surface.path === 'docs/readme.md')!;
    const state = useAppStore.getState(), doc = state.documents[documentKey(workspaceId, 'docs/readme.md')]!; state.updateDocument(tab.id, doc.content + '\n\nOriginal unsaved source stays here.\n', region.regionId) },
  async split(tabId: string, ratio: number) {
    const state = useAppStore.getState(), tab = state.tabs[tabId]!, region = Object.values(tab.regions).find(surface => surface.kind === 'browser' || surface.kind === 'file')!
    let next = tab.regions['original-neighbor'] ? tab : addWorkbenchRegion(tab, region.regionId, 'right', { regionId: 'original-neighbor', kind: 'file', workspaceId, path: 'notes.md' })
    if (next.layout.root.type === 'split') next = { ...next, layout: { ...next.layout, root: { ...next.layout.root, ratio }, activeRegionId: region.regionId } }
    flushSync(() => useAppStore.setState({ tabs: { ...state.tabs, [tabId]: next } }))
  },
  conversation(content: string, ratio = .65) {
    messageProjection = { content, ratio }
    flushSync(() => root.render(<DesktopClientUiProvider><Shell /></DesktopClientUiProvider>))
  },
  hideConversation() { messageProjection = null; flushSync(() => root.render(<DesktopClientUiProvider><Shell /></DesktopClientUiProvider>)) },
  activate(tabId: string) { const state = useAppStore.getState(); state.activateTab(workspaceId, state.layouts[workspaceId]!.activeGroupId, tabId) },
  theme(theme: 'light' | 'dark') { document.documentElement.dataset.appearance = theme },
  flush() { return prepareRendererUpdate('quit') }
}
Object.assign(window, { previewProbe: probe })
console.error('PRIVATE_STAGE preview-probe-ready')
