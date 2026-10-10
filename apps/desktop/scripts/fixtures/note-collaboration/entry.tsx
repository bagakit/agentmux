import { StrictMode } from 'react'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import { createRoot } from 'react-dom/client'
import { api } from '../../../src/renderer/src/lib/api'
import { prepareRendererUpdate, useAppStore } from '../../../src/renderer/src/store'
import { documentKey } from '../../../src/renderer/src/lib/workbench-tabs'
import { FileSurfaceView } from '../../../src/renderer/src/components/FileSurfaceView'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { WindowOverlayHost } from '../../../src/renderer/src/components/WindowOverlayHost'
import { WorkbenchPresentationContext } from '../../../src/renderer/src/lib/workbench-presentation'

import '../../../src/renderer/src/styles/index.css'
Object.assign(window, { __noteErrors: [] })
window.addEventListener('error', event => (window as any).__noteErrors.push({ message: event.message, stack: event.error?.stack }))
window.addEventListener('unhandledrejection', event => (window as any).__noteErrors.push({ message: String(event.reason), stack: event.reason?.stack }))

async function invoke(method: string, ...args: unknown[]) { const response = await fetch('/__note/invoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) }); const result = await response.json(); if (!response.ok) throw Object.assign(Error(result.error.message), { code: result.error.code }); return result.value }
const original = await invoke('bootstrap'), invalidations = new Set<(event: any) => void>(), spatial = new Set<(value: any) => void>()
const stopTheme = mountThemeRuntime(window, original.config.appearance)
const events = new EventSource('/__note/events')
events.onmessage = event => { const value = JSON.parse(event.data); if (value.channel === 'file') for (const listener of invalidations) listener(value.value) }
api.config.get = () => invoke('config.get')
api.sessions.list = async () => []
api.spatial.read = () => invoke('spatial.read')
api.spatial.commit = async input => { const value = await invoke('spatial.commit', input); for (const listener of spatial) listener(value); return value }
api.spatial.retainLabels = input => invoke('spatial.retainLabels', input)
api.spatial.onChange = listener => { spatial.add(listener); return () => { spatial.delete(listener) } }
api.notesStorage.inspect = () => invoke('notes.inspect')
api.notebooks.read = () => invoke('notebooks.read')
api.notebooks.actor = async () => original.actor
for (const method of ['read', 'write', 'list', 'observe', 'unobserve'] as const) (api.files[method] as any) = (...args: unknown[]) => invoke(method, ...args)
for (const [method, rpc] of [['readPublic', 'file.read'], ['createPublic', 'file.create'], ['historyPublic', 'file.history'], ['restorePublic', 'file.restore'], ['undoPublic', 'file.undo']] as const) api.files[method] = input => invoke('rpc', rpc, input)
api.files.onInvalidated = listener => { invalidations.add(listener); return () => { invalidations.delete(listener) } }
api.ui.requestStorageFlush = () => invoke('storage.flush', localStorage.getItem('agentmux-workbench-v1'))
const ready = await useAppStore.getState().initialize(), key = documentKey(original.workspace.id, original.path)
if (!useAppStore.getState().documents[key]) await useAppStore.getState().reloadDocument(original.tabId, original.regionId)
const tab = useAppStore.getState().tabs[original.tabId], surface = tab?.regions[original.regionId]
if (surface?.kind !== 'file') throw Error('The original private File Region was not restored; no replacement was created')
const reference = { displayWorkspaceId: original.workspace.id, groupId: original.groupId, tabId: original.tabId, regionId: original.regionId }
Object.assign(window, { noteCollaboration: { original, async flush() { await prepareRendererUpdate() }, async loseNextReply() { await invoke('loseNextReply') }, async omitNextCanonical() { await invoke('omitNextCanonical') }, async resumeObservation() { await invoke('resumeObservation') },
  async facts() { const state = useAppStore.getState(); return { original, host: await invoke('facts'), document: state.documents[key], retained: state.retainedDocumentDrafts[key], issue: state.documentIssues[key], dirty: state.dirtyDocuments[key], saving: state.savingDocuments[key], tab: state.tabs[original.tabId], layout: state.layouts[original.workspace.id], loading: state.loading, error: state.error, invalidationSubscribers: invalidations.size, localStorage: localStorage.getItem('agentmux-workbench-v1') } },
  async save() { await useAppStore.getState().saveDocument(original.tabId, original.regionId) },
  async check() { await useAppStore.getState().reloadDocument(original.tabId, original.regionId) }, dispose() { ready(); events.close(); stopTheme() } } })
createRoot(document.getElementById('root')!).render(<StrictMode><DesktopClientUiProvider><WindowOverlayHost /><WorkbenchPresentationContext.Provider value={{ active: true, retainedRegionId: null, tabHostId: 'fixture-primary', reference }}>
  <main style={{ width: 1000, height: '100vh', margin: 'auto', background: 'var(--bg)' }} data-workbench-region-id={surface.regionId}><FileSurfaceView tabId={original.tabId} surface={surface} /></main>
</WorkbenchPresentationContext.Provider></DesktopClientUiProvider></StrictMode>)
