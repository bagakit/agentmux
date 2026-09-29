import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { FileExplorer } from '../../../src/renderer/src/components/FileExplorer'
import { WindowOverlayHost } from '../../../src/renderer/src/components/WindowOverlayHost'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { addWorkbenchRegion, documentKey, fileTabId, type FileWorkbenchSurface } from '../../../src/renderer/src/lib/workbench-tabs'
import '../../../src/renderer/src/styles/index.css'

const boot = (window as any).filePreviewFixtureBoot
if (!boot || !window.agentmux) throw new Error('Private native preload facts are required')
const workspaceId = boot.config.workspaces[0].id
api.files = window.agentmux.files
api.config.get = async () => structuredClone(boot.config)
api.config.save = async (config) => structuredClone(config)
api.sessions.snapshot = async () => ({ sessions: [], timelines: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [], environmentWarning: null })
await useAppStore.getState().initialize()
const restored = useAppStore.getState()
const beforeFixture = boot.phase === 'restart' ? { tabs: structuredClone(restored.tabs), layouts: structuredClone(restored.layouts),
  activeWorkspaceId: restored.activeWorkspaceId, documents: structuredClone(restored.documents), dirtyDocuments: structuredClone(restored.dirtyDocuments) } : null
const root = createRoot(document.getElementById('root')!)
function Shell() { return <><aside id="fixture-tree"><FileExplorer /></aside><div id="fixture-workbench"><WorkspaceWorkbench workspaceId={workspaceId} /></div><WindowOverlayHost /></> }
flushSync(() => root.render(<Shell />))
const probe = {
  workspaceId, beforeFixture,
  activeRegion() {
    const state = useAppStore.getState(), layout = state.layouts[workspaceId]
    const group = layout?.groups.find(group => group.id === layout.activeGroupId), tab = group?.activeTabId ? state.tabs[group.activeTabId] : null
    return tab ? document.querySelector(`[data-workbench-region-id="${tab.layout.activeRegionId}"]`) : null
  },
  async open(path: string) { await useAppStore.getState().openFile(path, undefined, undefined, workspaceId) },
  async split(path: string, ratio = .34, theme: 'dark' | 'light' = 'dark') {
    probe.theme(theme)
    await useAppStore.getState().openFile('notes.md', undefined, undefined, workspaceId)
    await probe.open(path)
    const state = useAppStore.getState(), tabId = fileTabId(workspaceId, path), tab = state.tabs[tabId]!
    const regionId = tab.layout.activeRegionId
    const oldNeighbor = Object.values(tab.regions).find(surface => surface.regionId !== regionId)
    let next = oldNeighbor ? tab : addWorkbenchRegion(tab, regionId, 'right', { regionId: 'preview-neighbor', kind: 'file', workspaceId, path: 'notes.md' })
    if (next.layout.root.type === 'split') next = { ...next, layout: { ...next.layout, root: { ...next.layout.root, ratio }, activeRegionId: regionId } }
    flushSync(() => useAppStore.setState({ tabs: { ...state.tabs, [tabId]: next } }))
  },
  edit(path: string, content: string) {
    const state = useAppStore.getState(), tabId = fileTabId(workspaceId, path), tab = state.tabs[tabId]!
    state.updateDocument(tabId, content, tab.layout.activeRegionId)
  },
  theme(theme: 'dark' | 'light') {
    document.documentElement.dataset.appearance = theme
    useAppStore.setState(state => ({ config: state.config ? { ...state.config, appearance: { ...state.config.appearance, appAppearance: theme } } : null }))
  },
  facts() {
    const state = useAppStore.getState()
    return { tabs: state.tabs, layouts: state.layouts, activeWorkspaceId: state.activeWorkspaceId,
      documents: state.documents, dirtyDocuments: state.dirtyDocuments, issues: state.documentIssues,
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
  key: (path: string) => documentKey(workspaceId, path)
}
Object.assign(window, { filePreviewProbe: probe })
