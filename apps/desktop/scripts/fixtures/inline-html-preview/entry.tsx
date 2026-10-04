import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { FileExplorer } from '../../../src/renderer/src/components/FileExplorer'
import { WindowOverlayHost } from '../../../src/renderer/src/components/WindowOverlayHost'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { addWorkbenchRegion, documentKey, fileTabId } from '../../../src/renderer/src/lib/workbench-tabs'
import '../../../src/renderer/src/styles/index.css'

const boot = (window as any).inlineHtmlFixtureBoot
if (!boot || !window.agentmux) throw new Error('Private native preload facts are required')
const workspaceId = boot.config.workspaces[0].id
// Only non-file capabilities use the existing controlled web-preview adapter.
// Every file operation, including draft HTML allocation/release, uses production preload.
api.files = window.agentmux.files
api.config.get = async () => structuredClone(boot.config)
api.config.save = async config => structuredClone(config)
api.sessions.snapshot = async () => ({ sessions: [], timelines: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [], environmentWarning: null })
await useAppStore.getState().initialize()
const root = createRoot(document.getElementById('root')!)
flushSync(() => root.render(<DesktopClientUiProvider><aside id="fixture-tree"><FileExplorer /></aside><div id="fixture-workbench"><WorkspaceWorkbench workspaceId={workspaceId} /></div><WindowOverlayHost /></DesktopClientUiProvider>))
const probe = {
  workspaceId,
  activeRegion() {
    const state = useAppStore.getState(), layout = state.layouts[workspaceId]
    const group = layout?.groups.find(item => item.id === layout.activeGroupId)
    const tab = group?.activeTabId ? state.tabs[group.activeTabId] : null
    return tab ? document.querySelector(`[data-workbench-region-id="${tab.layout.activeRegionId}"]`) : null
  },
  async open(path: string) { await useAppStore.getState().openFile(path, undefined, undefined, workspaceId) },
  async split() {
    await probe.open('notes.md')
    await probe.open('index.html')
    const state = useAppStore.getState(), tabId = fileTabId(workspaceId, 'index.html'), tab = state.tabs[tabId]!
    let next = addWorkbenchRegion(tab, tab.layout.activeRegionId, 'right', { regionId: 'preview-neighbor', kind: 'file', workspaceId, path: 'notes.md' })
    if (next.layout.root.type === 'split') next = { ...next, layout: { ...next.layout, root: { ...next.layout.root, ratio: .5 }, activeRegionId: tab.layout.activeRegionId } }
    flushSync(() => useAppStore.setState({ tabs: { ...state.tabs, [tabId]: next } }))
  },
  facts() {
    const state = useAppStore.getState()
    return structuredClone({ tabs: state.tabs, layouts: state.layouts, activeWorkspaceId: state.activeWorkspaceId,
      documents: state.documents, dirtyDocuments: state.dirtyDocuments, issues: state.documentIssues, modes: state.editorRegionModes })
  },
  geometry() {
    const region = probe.activeRegion()!, bounds = region.getBoundingClientRect(), close = region.querySelector('.workbench-region__close')?.getBoundingClientRect()
    const header = region.querySelector('.editor-header')!
    return { regionId: region.getAttribute('data-workbench-region-id'), region: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      iframe: region.querySelector('iframe') ? { sandbox: region.querySelector('iframe')!.getAttribute('sandbox'), title: region.querySelector('iframe')!.title } : null,
      controls: [...header.querySelectorAll('button')].map(button => {
        const box = button.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
        return { label: button.title || button.getAttribute('aria-label') || button.textContent, width: box.width, disabled: button.disabled,
          inside: box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom,
          overlapsClose: Boolean(close && box.left < close.right && box.right > close.left && box.top < close.bottom && box.bottom > close.top),
          hitOwnControl: hit === button || Boolean(hit && button.contains(hit)) }
      }) }
  },
  key: (path: string) => documentKey(workspaceId, path),
  unmount() { flushSync(() => root.unmount()) }
}
Object.assign(window, { inlineHtmlProbe: probe })
