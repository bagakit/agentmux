import type { FileDocument } from '../../../shared/contracts'
import { activateTab, addTab, removeTab, type WorkspaceLayout } from './workbench-layout'
import {
  documentKey,
  fileTabId,
  paneForTab,
  remapLayoutTabIds,
  tabStillOpen,
  type FileWorkbenchTab,
  type WorkbenchTab
} from './workbench-tabs'
import { isPathWithinSubtree, remapPathWithinSubtree } from './workspace-paths'

export type FileWorkbenchState = {
  tabs: Record<string, WorkbenchTab>
  documents: Record<string, FileDocument>
  dirtyDocuments: Record<string, boolean>
  layouts: Record<string, WorkspaceLayout>
  lastActiveFileByWorkspace: Record<string, string | undefined>
}

export function reduceFileOpened(
  state: FileWorkbenchState,
  workspaceId: string,
  path: string,
  document: FileDocument,
  preferredPaneId?: string
): FileWorkbenchState {
  const layout = state.layouts[workspaceId]
  if (!layout) return state
  const tabId = fileTabId(workspaceId, path)
  const existingPaneId = paneForTab(layout, tabId)
  const targetPaneId = existingPaneId ?? preferredPaneId ?? layout.activeGroupId
  const tab: FileWorkbenchTab = { id: tabId, kind: 'file', workspaceId, path }
  return {
    ...state,
    documents: { ...state.documents, [documentKey(workspaceId, path)]: document },
    tabs: { ...state.tabs, [tab.id]: tab },
    lastActiveFileByWorkspace: { ...state.lastActiveFileByWorkspace, [workspaceId]: path },
    layouts: {
      ...state.layouts,
      [workspaceId]: existingPaneId
        ? activateTab(layout, targetPaneId, tabId)
        : addTab(layout, targetPaneId, tabId)
    }
  }
}

export function reduceDocumentContent(
  state: FileWorkbenchState,
  tabId: string,
  content: string
): FileWorkbenchState {
  const tab = state.tabs[tabId]
  if (tab?.kind !== 'file') return state
  const key = documentKey(tab.workspaceId, tab.path)
  const current = state.documents[key]
  if (!current) return state
  return {
    ...state,
    documents: { ...state.documents, [key]: { ...current, content } },
    dirtyDocuments: { ...state.dirtyDocuments, [key]: true }
  }
}

export function reduceDocumentSaved(
  state: FileWorkbenchState,
  workspaceId: string,
  path: string
): FileWorkbenchState {
  const key = documentKey(workspaceId, path)
  return {
    ...state,
    dirtyDocuments: { ...state.dirtyDocuments, [key]: false }
  }
}

export function reduceFileClosed(
  state: FileWorkbenchState,
  workspaceId: string,
  paneId: string,
  tabId: string
): FileWorkbenchState {
  const tab = state.tabs[tabId]
  const layout = state.layouts[workspaceId]
  if (tab?.kind !== 'file' || !layout) return state
  const layouts = {
    ...state.layouts,
    [workspaceId]: removeTab(layout, paneId, tabId)
  }
  if (tabStillOpen(layouts, tabId)) return { ...state, layouts }
  const tabs = { ...state.tabs }
  const documents = { ...state.documents }
  const dirtyDocuments = { ...state.dirtyDocuments }
  delete tabs[tabId]
  delete documents[documentKey(tab.workspaceId, tab.path)]
  delete dirtyDocuments[documentKey(tab.workspaceId, tab.path)]
  return {
    tabs,
    documents,
    dirtyDocuments,
    layouts,
    lastActiveFileByWorkspace: {
      ...state.lastActiveFileByWorkspace,
      [workspaceId]: state.lastActiveFileByWorkspace[workspaceId] === tab.path
        ? undefined
        : state.lastActiveFileByWorkspace[workspaceId]
    }
  }
}

export function reduceFileRename(
  state: FileWorkbenchState,
  workspaceId: string,
  path: string,
  nextPath: string
): FileWorkbenchState {
  const affectedTabs = Object.values(state.tabs).filter(
    (tab): tab is FileWorkbenchTab =>
      tab.kind === 'file' &&
      tab.workspaceId === workspaceId &&
      isPathWithinSubtree(tab.path, path)
  )
  const replacements = new Map(
    affectedTabs.map((tab) => [
      tab.id,
      fileTabId(workspaceId, remapPathWithinSubtree(tab.path, path, nextPath))
    ])
  )
  const tabs = { ...state.tabs }
  const documents = { ...state.documents }
  const dirtyDocuments = { ...state.dirtyDocuments }
  for (const tab of affectedTabs) {
    const renamedPath = remapPathWithinSubtree(tab.path, path, nextPath)
    const nextId = replacements.get(tab.id)!
    delete tabs[tab.id]
    tabs[nextId] = { ...tab, id: nextId, path: renamedPath }
  }
  const documentPrefix = `${workspaceId}\0`
  for (const [key, document] of Object.entries(state.documents)) {
    if (!key.startsWith(documentPrefix)) continue
    const documentPath = key.slice(documentPrefix.length)
    if (!isPathWithinSubtree(documentPath, path)) continue
    const renamedPath = remapPathWithinSubtree(documentPath, path, nextPath)
    delete documents[key]
    documents[documentKey(workspaceId, renamedPath)] = { ...document, path: renamedPath }
  }
  for (const [key, dirty] of Object.entries(state.dirtyDocuments)) {
    if (!key.startsWith(documentPrefix)) continue
    const documentPath = key.slice(documentPrefix.length)
    if (!isPathWithinSubtree(documentPath, path)) continue
    delete dirtyDocuments[key]
    dirtyDocuments[documentKey(workspaceId, remapPathWithinSubtree(documentPath, path, nextPath))] = dirty
  }
  return {
    tabs,
    documents,
    dirtyDocuments,
    layouts: Object.fromEntries(
      Object.entries(state.layouts).map(([id, layout]) => [
        id,
        id === workspaceId ? remapLayoutTabIds(layout, replacements) : layout
      ])
    ),
    lastActiveFileByWorkspace: {
      ...state.lastActiveFileByWorkspace,
      [workspaceId]: state.lastActiveFileByWorkspace[workspaceId]
        ? remapPathWithinSubtree(state.lastActiveFileByWorkspace[workspaceId], path, nextPath)
        : undefined
    }
  }
}

export function reduceFileDelete(
  state: FileWorkbenchState,
  workspaceId: string,
  path: string
): FileWorkbenchState {
  const removedTabs = Object.values(state.tabs).filter(
    (tab): tab is FileWorkbenchTab =>
      tab.kind === 'file' &&
      tab.workspaceId === workspaceId &&
      isPathWithinSubtree(tab.path, path)
  )
  let layout = state.layouts[workspaceId]
  if (layout) {
    for (const tab of removedTabs) {
      const groupId = paneForTab(layout, tab.id)
      if (groupId) layout = removeTab(layout, groupId, tab.id)
    }
  }
  const tabs = { ...state.tabs }
  const documents = { ...state.documents }
  const dirtyDocuments = { ...state.dirtyDocuments }
  for (const tab of removedTabs) {
    delete tabs[tab.id]
  }
  const documentPrefix = `${workspaceId}\0`
  for (const key of Object.keys(state.documents)) {
    if (!key.startsWith(documentPrefix)) continue
    if (isPathWithinSubtree(key.slice(documentPrefix.length), path)) delete documents[key]
  }
  for (const key of Object.keys(state.dirtyDocuments)) {
    if (!key.startsWith(documentPrefix)) continue
    if (isPathWithinSubtree(key.slice(documentPrefix.length), path)) delete dirtyDocuments[key]
  }
  return {
    tabs,
    documents,
    dirtyDocuments,
    layouts: layout ? { ...state.layouts, [workspaceId]: layout } : state.layouts,
    lastActiveFileByWorkspace: {
      ...state.lastActiveFileByWorkspace,
      [workspaceId]: state.lastActiveFileByWorkspace[workspaceId] &&
        isPathWithinSubtree(state.lastActiveFileByWorkspace[workspaceId], path)
        ? undefined
        : state.lastActiveFileByWorkspace[workspaceId]
    }
  }
}
