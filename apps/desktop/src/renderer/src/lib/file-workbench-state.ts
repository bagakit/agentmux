import type { FileDocument } from '../../../shared/contracts'
import { activateTab, addTab, removeTab, type WorkspaceLayout } from './workbench-layout'
import {
  documentKey,
  fileTabId,
  paneForTab,
  remapLayoutTabIds,
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
    const oldKey = documentKey(workspaceId, tab.path)
    const nextKey = documentKey(workspaceId, renamedPath)
    const document = documents[oldKey]
    if (document) {
      delete documents[oldKey]
      documents[nextKey] = { ...document, path: renamedPath }
    }
    if (oldKey in dirtyDocuments) {
      dirtyDocuments[nextKey] = dirtyDocuments[oldKey] ?? false
      delete dirtyDocuments[oldKey]
    }
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
    const key = documentKey(workspaceId, tab.path)
    delete documents[key]
    delete dirtyDocuments[key]
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
