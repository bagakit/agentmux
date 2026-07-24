import type { FileDocument, WorkspaceFileReadResult } from '../../../shared/contracts'
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
  documentGenerations: Record<string, number>
  documentObservationGenerations: Record<string, number>
  documentIssues: Record<string, FileDocumentIssue | undefined>
  savingDocuments: Record<string, boolean>
  layouts: Record<string, WorkspaceLayout>
  lastActiveFileByWorkspace: Record<string, string | undefined>
}

export type FileDocumentIssue =
  | { kind: 'changed'; observed: FileDocument }
  | { kind: 'deleted' }
  | { kind: 'read-error'; code: string; message: string }
  | { kind: 'write-error'; code: string; message: string }

function withoutIssue(
  issues: FileWorkbenchState['documentIssues'],
  key: string
): FileWorkbenchState['documentIssues'] {
  if (!issues[key]) return issues
  const next = { ...issues }
  delete next[key]
  return next
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
  const key = documentKey(workspaceId, path)
  const alreadyOpen = Boolean(state.documents[key])
  const existingPaneId = paneForTab(layout, tabId)
  const targetPaneId = existingPaneId ?? preferredPaneId ?? layout.activeGroupId
  const tab: FileWorkbenchTab = { id: tabId, kind: 'file', workspaceId, path }
  return {
    ...state,
    documents: { ...state.documents, [key]: alreadyOpen ? state.documents[key]! : document },
    documentGenerations: {
      ...state.documentGenerations,
      [key]: state.documentGenerations[key] ?? 0
    },
    documentObservationGenerations: {
      ...state.documentObservationGenerations,
      [key]: state.documentObservationGenerations[key] ?? 0
    },
    documentIssues: alreadyOpen ? state.documentIssues : withoutIssue(state.documentIssues, key),
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
    dirtyDocuments: { ...state.dirtyDocuments, [key]: true },
    documentGenerations: {
      ...state.documentGenerations,
      [key]: (state.documentGenerations[key] ?? 0) + 1
    },
    documentIssues: state.documentIssues[key]?.kind === 'write-error'
      ? withoutIssue(state.documentIssues, key)
      : state.documentIssues
  }
}

export function reduceDocumentWritten(
  state: FileWorkbenchState,
  workspaceId: string,
  path: string,
  savedGeneration: number,
  revision: string,
  expectedRevision: string | null = revision,
  savedObservationGeneration = 0
): FileWorkbenchState {
  const key = documentKey(workspaceId, path)
  const document = state.documents[key]
  if (!document) return state
  const issue = state.documentIssues[key]
  const observedConflictIsSavedRevision =
    issue?.kind === 'changed' && issue.observed.revision === revision
  const observedConflictWasCaptured =
    (state.documentObservationGenerations[key] ?? 0) === savedObservationGeneration && (
      (issue?.kind === 'changed' && issue.observed.revision === expectedRevision) ||
      (issue?.kind === 'deleted' && expectedRevision === null)
    )
  const clearsIssue = issue?.kind === 'write-error' ||
    observedConflictIsSavedRevision ||
    observedConflictWasCaptured
  const hasNewerDiskConflict =
    (issue?.kind === 'changed' && !clearsIssue) ||
    (issue?.kind === 'deleted' && !clearsIssue)
  return {
    ...state,
    documents: { ...state.documents, [key]: { ...document, revision } },
    dirtyDocuments: {
      ...state.dirtyDocuments,
      [key]: (state.documentGenerations[key] ?? 0) !== savedGeneration || hasNewerDiskConflict
    },
    documentIssues: clearsIssue ? withoutIssue(state.documentIssues, key) : state.documentIssues,
    savingDocuments: { ...state.savingDocuments, [key]: false }
  }
}

export function reduceDocumentRead(
  state: FileWorkbenchState,
  workspaceId: string,
  path: string,
  result: WorkspaceFileReadResult
): FileWorkbenchState {
  const key = documentKey(workspaceId, path)
  const current = state.documents[key]
  if (!current) return state
  const documentObservationGenerations = {
    ...state.documentObservationGenerations,
    [key]: (state.documentObservationGenerations[key] ?? 0) + 1
  }
  if (result.status === 'deleted') {
    return {
      ...state,
      documentObservationGenerations,
      documentIssues: { ...state.documentIssues, [key]: { kind: 'deleted' } }
    }
  }
  if (result.status === 'error') {
    return {
      ...state,
      documentObservationGenerations,
      documentIssues: {
        ...state.documentIssues,
        [key]: { kind: 'read-error', code: result.code, message: result.message }
      }
    }
  }
  if (result.document.revision === current.revision) {
    const issue = state.documentIssues[key]
    return issue?.kind === 'changed' || issue?.kind === 'deleted' || issue?.kind === 'read-error'
      ? { ...state, documentObservationGenerations, documentIssues: withoutIssue(state.documentIssues, key) }
      : { ...state, documentObservationGenerations }
  }
  if (state.dirtyDocuments[key]) {
    return {
      ...state,
      documentObservationGenerations,
      documentIssues: {
        ...state.documentIssues,
        [key]: { kind: 'changed', observed: result.document }
      }
    }
  }
  return {
    ...state,
    documentObservationGenerations,
    documents: { ...state.documents, [key]: result.document },
    dirtyDocuments: { ...state.dirtyDocuments, [key]: false },
    documentGenerations: {
      ...state.documentGenerations,
      [key]: (state.documentGenerations[key] ?? 0) + 1
    },
    documentIssues: withoutIssue(state.documentIssues, key)
  }
}

export function reduceDocumentReloaded(
  state: FileWorkbenchState,
  workspaceId: string,
  path: string,
  document: FileDocument
): FileWorkbenchState {
  const key = documentKey(workspaceId, path)
  if (!state.documents[key]) return state
  return {
    ...state,
    documents: { ...state.documents, [key]: document },
    dirtyDocuments: { ...state.dirtyDocuments, [key]: false },
    documentGenerations: {
      ...state.documentGenerations,
      [key]: (state.documentGenerations[key] ?? 0) + 1
    },
    documentIssues: withoutIssue(state.documentIssues, key)
  }
}

export function reduceDocumentSaving(
  state: FileWorkbenchState,
  workspaceId: string,
  path: string,
  saving: boolean
): FileWorkbenchState {
  const key = documentKey(workspaceId, path)
  return {
    ...state,
    savingDocuments: { ...state.savingDocuments, [key]: saving },
    ...(saving && state.documentIssues[key]?.kind === 'write-error'
      ? { documentIssues: withoutIssue(state.documentIssues, key) }
      : {})
  }
}

export function reduceDocumentWriteError(
  state: FileWorkbenchState,
  workspaceId: string,
  path: string,
  code: string,
  message: string
): FileWorkbenchState {
  const key = documentKey(workspaceId, path)
  return {
    ...state,
    savingDocuments: { ...state.savingDocuments, [key]: false },
    documentIssues: {
      ...state.documentIssues,
      [key]: { kind: 'write-error', code, message }
    }
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
  const documentGenerations = { ...state.documentGenerations }
  const documentObservationGenerations = { ...state.documentObservationGenerations }
  const documentIssues = { ...state.documentIssues }
  const savingDocuments = { ...state.savingDocuments }
  const key = documentKey(tab.workspaceId, tab.path)
  delete tabs[tabId]
  delete documents[key]
  delete dirtyDocuments[key]
  delete documentGenerations[key]
  delete documentObservationGenerations[key]
  delete documentIssues[key]
  delete savingDocuments[key]
  return {
    tabs,
    documents,
    dirtyDocuments,
    documentGenerations,
    documentObservationGenerations,
    documentIssues,
    savingDocuments,
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
  const documentGenerations = { ...state.documentGenerations }
  const documentObservationGenerations = { ...state.documentObservationGenerations }
  const documentIssues = { ...state.documentIssues }
  const savingDocuments = { ...state.savingDocuments }
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
  for (const collection of [documentGenerations, documentObservationGenerations, documentIssues]) {
    for (const [key, value] of Object.entries(collection)) {
      if (!key.startsWith(documentPrefix)) continue
      const documentPath = key.slice(documentPrefix.length)
      if (!isPathWithinSubtree(documentPath, path)) continue
      delete collection[key]
      collection[documentKey(workspaceId, remapPathWithinSubtree(documentPath, path, nextPath))] = value
    }
  }
  for (const key of Object.keys(savingDocuments)) {
    if (!key.startsWith(documentPrefix)) continue
    const documentPath = key.slice(documentPrefix.length)
    if (!isPathWithinSubtree(documentPath, path)) continue
    delete savingDocuments[key]
    savingDocuments[documentKey(workspaceId, remapPathWithinSubtree(documentPath, path, nextPath))] = false
  }
  return {
    tabs,
    documents,
    dirtyDocuments,
    documentGenerations,
    documentObservationGenerations,
    documentIssues,
    savingDocuments,
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
  const documentGenerations = { ...state.documentGenerations }
  const documentObservationGenerations = { ...state.documentObservationGenerations }
  const documentIssues = { ...state.documentIssues }
  const savingDocuments = { ...state.savingDocuments }
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
  for (const collection of [documentGenerations, documentObservationGenerations, documentIssues, savingDocuments]) {
    for (const key of Object.keys(collection)) {
      if (!key.startsWith(documentPrefix)) continue
      if (isPathWithinSubtree(key.slice(documentPrefix.length), path)) delete collection[key]
    }
  }
  return {
    tabs,
    documents,
    dirtyDocuments,
    documentGenerations,
    documentObservationGenerations,
    documentIssues,
    savingDocuments,
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
