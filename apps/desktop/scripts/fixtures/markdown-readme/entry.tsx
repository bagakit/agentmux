import { createClientUiRoot as createRoot } from '../../../test/helpers/client-ui-render'
import { flushSync } from 'react-dom'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { FileExplorer } from '../../../src/renderer/src/components/FileExplorer'
import { WindowOverlayHost } from '../../../src/renderer/src/components/WindowOverlayHost'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { addWorkbenchRegion, documentKey, fileTabId, type FileWorkbenchSurface } from '../../../src/renderer/src/lib/workbench-tabs'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import '../../../src/renderer/src/styles/index.css'

const boot = (window as any).filePreviewFixtureBoot
if (!boot || !window.agentmux) throw new Error('Private native preload facts are required')
const workspaceId = boot.config.workspaces[0].id
api.files = window.agentmux.files
api.spatial = window.agentmux.spatial
api.config.get = async () => structuredClone(boot.config)
// Saves go through the production preload to the fixture Main, which merges and pushes like the ConfigOwner.
api.config.save = (config, expected) => window.agentmux.config.save(config, expected)
api.sessions.snapshot = async () => ({ sessions: [], timelines: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [], environmentWarning: null })
await useAppStore.getState().initialize()
// The production App mounts one theme runtime that owns tokens and the resolved appearance; mount the same owner.
mountThemeRuntime(window, { appAppearance: 'dark' })
// App.tsx applies each committed configuration pushed by Main; the fixture mounts the same subscription.
window.agentmux.config.onChange(committed => useAppStore.getState().setConfig(committed))
const restored = useAppStore.getState()
const beforeFixture = boot.phase.endsWith('restart') ? { tabs: structuredClone(restored.tabs), layouts: structuredClone(restored.layouts),
  activeWorkspaceId: restored.activeWorkspaceId, documents: structuredClone(restored.documents), dirtyDocuments: structuredClone(restored.dirtyDocuments) } : null
const root = createRoot(document.getElementById('root')!)
const activationScene = boot.phase.startsWith('activation')
if (activationScene && boot.phase === 'activation') useAppStore.setState({ mainSurface: 'agents' })
function Shell() {
  const mainSurface = useAppStore(state => state.mainSurface)
  const visible = !activationScene || mainSurface === 'workbench'
  return <><aside id="fixture-tree"><FileExplorer /></aside>
    <div id="fixture-workbench" style={visible ? undefined : { display: 'none' }}><WorkspaceWorkbench workspaceId={workspaceId} visible={visible} /></div>
    {activationScene && !visible ? <div>Private Focus selection before file navigation</div> : null}<WindowOverlayHost /></>
}
flushSync(() => root.render(<Shell />))
const probe = {
  workspaceId, beforeFixture,
  activeRegion() {
    const state = useAppStore.getState(), layout = state.layouts[workspaceId]
    const group = layout?.groups.find(group => group.id === layout.activeGroupId), tab = group?.activeTabId ? state.tabs[group.activeTabId] : null
    return tab ? document.querySelector(`[data-workbench-region-id="${tab.layout.activeRegionId}"]`) : null
  },
  async open(path: string) {
    await useAppStore.getState().openFile(path, undefined, undefined, workspaceId)
    const state = useAppStore.getState(), layout = state.layouts[workspaceId]!
    const tabId = fileTabId(workspaceId, path), group = layout.groups.find(group => group.tabOrder.includes(tabId))
    if(group) state.activateTab(workspaceId, group.id, tabId, 'local')
  },
  async split(path: string, ratio = .34, theme: 'dark' | 'light' = 'dark') {
    probe.theme(theme)
    await useAppStore.getState().openFile('notes.md', undefined, undefined, workspaceId)
    await probe.open(path)
    const state = useAppStore.getState(), tabId = fileTabId(workspaceId, path), tab = state.tabs[tabId]!
    const regionId = tab.layout.activeRegionId
    const oldNeighbor = Object.values(tab.regions).find(surface => surface.regionId !== regionId)
    let next = oldNeighbor ? tab : addWorkbenchRegion(tab, regionId, 'right', { regionId: 'preview-neighbor:'+path, kind: 'file', workspaceId, path: 'notes.md' })
    if (next.layout.root.type === 'split') next = { ...next, layout: { ...next.layout, root: { ...next.layout.root, ratio }, activeRegionId: regionId } }
    flushSync(() => useAppStore.setState({ tabs: { ...state.tabs, [tabId]: next } }))
  },
  async source(path: string) {
    const state = useAppStore.getState(), tab = state.tabs[fileTabId(workspaceId, path)]!
    for (const region of Object.values(state.tabs).flatMap(tab => Object.values(tab.regions))) if(region.kind === 'file' && region.path === path) await state.setEditorRegionMode(region.regionId, workspaceId, path, 'edit')
  },
  edit(path: string, content: string) {
    const state = useAppStore.getState(), tabId = fileTabId(workspaceId, path), tab = state.tabs[tabId]!
    state.updateDocument(tabId, content, tab.layout.activeRegionId)
  },
  theme(theme: 'dark' | 'light') {
    updateThemeSelection({ appAppearance: theme })
    useAppStore.setState(state => ({ config: state.config ? { ...state.config, appearance: { ...state.config.appearance, appAppearance: theme } } : null }))
  },
  facts() {
    const state = useAppStore.getState()
    return { tabs: state.tabs, layouts: state.layouts, activeWorkspaceId: state.activeWorkspaceId,
      documents: state.documents, dirtyDocuments: state.dirtyDocuments, issues: state.documentIssues,
      mainSurface: state.mainSurface, selection: state.workbenchSpaceSelection, caret: state.regionCaretFocus,
      persisted: JSON.parse(localStorage.getItem('agentmux-workbench-v1') ?? 'null') }
  },
  geometry(path: string) {
    const tab = useAppStore.getState().tabs[fileTabId(workspaceId, path)]!, file = Object.values(tab.regions).find(surface => surface.kind === 'file' && surface.path === path) as FileWorkbenchSurface
    const region = document.querySelector(`[data-workbench-region-id="${file.regionId}"]`)!
    const viewport = region.querySelector('.image-preview__viewport') as HTMLElement | null
    const image = viewport?.querySelector('img'), bounds = region.getBoundingClientRect()
    return { regionId: file.regionId, region: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      image: image ? { naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, width: image.width, height: image.height, src: image.src } : null,
      viewport: viewport ? { width: viewport.clientWidth, height: viewport.clientHeight, scrollWidth: viewport.scrollWidth, scrollHeight: viewport.scrollHeight } : null,
      controls: [...region.querySelectorAll('button')].map(element => ({ label: element.getAttribute('aria-label') ?? element.textContent, width: element.getBoundingClientRect().width, right: element.getBoundingClientRect().right, bottom: element.getBoundingClientRect().bottom })) }
  },
  headerControls() {
    return [...document.querySelectorAll('.workbench-region')].flatMap(region => {
      const header = region.querySelector('.editor-header')
      if (!header || region.closest('[inert]') || getComputedStyle(header).visibility !== 'visible' || !header.getBoundingClientRect().width) return []
      const close = region.querySelector('.workbench-region__close')?.getBoundingClientRect()
      const bounds = region.getBoundingClientRect()
      return [{ regionId: region.getAttribute('data-workbench-region-id'), controls: [...header.querySelectorAll('button')].map(button => {
        const box = button.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
        return { label: button.getAttribute('aria-label') || button.title || button.textContent, width: box.width,
          inside: box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom,
          overlapsClose: Boolean(close && box.left < close.right && box.right > close.left && box.top < close.bottom && box.bottom > close.top),
          hitOwnControl: hit === button || Boolean(hit && button.contains(hit)), disabled: button.disabled,
          hitElement: hit ? { tag: hit.tagName, class: hit.getAttribute('class'), label: hit.getAttribute('aria-label') } : null,
          bounds: { left:box.left, top:box.top, width:box.width, height:box.height } }
      }) }]
    })
  },
  flush() { return prepareRendererUpdate('quit') },
  unmount() { flushSync(() => root.unmount()) },
  key: (path: string) => documentKey(workspaceId, path)
}
// Conversation reading of the same README HTML: the real ConversationMessage in an Agent reply and a user
// message, mounted in a separate root so the Workbench layout stays as the file preview frames left it.
const conversationContent = '> [!NOTE]\n> The reply quotes a README alert.\n\n<div align="center"><b>Centered</b> H<sub>2</sub>O and <kbd>Ctrl</kbd></div>\n\n' +
  '<table><tr><td width="50%"><b>Space</b><br><sub>Where work is shown.</sub></td><td width="50%"><b>Focus</b><br><sub>Who needs you now.</sub></td></tr></table>\n\n' +
  '![Badge](https://img.shields.io/badge/tests-passing-8de3ae)'
const conversationHost = document.createElement('div')
conversationHost.id = 'conversation-scene'
conversationHost.style.cssText = 'position:fixed;inset:0;z-index:50;display:none;overflow:auto;padding:24px;box-sizing:border-box;background:var(--surface-0);color:var(--text);font-size:var(--fs-body);font-family:var(--font-sans)'
document.body.append(conversationHost)
const conversationRoot = createRoot(conversationHost)
Object.assign(probe, {
  conversation(width: number) {
    conversationHost.style.display = 'block'
    flushSync(() => conversationRoot.render(<main className="activity-feed" style={{ maxWidth: width, margin: '0 auto' }}>
      <ConversationMessage messageId="readme-reply" conversationSessionId="readme-agent" speaker={{ role: 'agent', id: 'readme-agent' }} name="Docs" providerId="claude" content={conversationContent} />
      <ConversationMessage messageId="readme-input" conversationSessionId="readme-agent" speaker={{ role: 'user', id: 'person' }} name="You" content={conversationContent} />
    </main>))
  },
  conversationFacts() {
    const scene = document.getElementById('conversation-scene')!, bodies = [...scene.querySelectorAll<HTMLElement>('.md')]
    return { bodies: bodies.length, documentMode: scene.querySelectorAll('.md-document').length, remote: scene.querySelectorAll('img.md-remote-image').length,
      overflow: bodies.map(body => { const outer = body.getBoundingClientRect(); return [...body.querySelectorAll('.md-html-table--layout, .md-alert')].some(node => { const r = node.getBoundingClientRect(); return r.left < outer.left - 1 || r.right > outer.right + 1 }) }) }
  }
})
Object.assign(window, { filePreviewProbe: probe })
