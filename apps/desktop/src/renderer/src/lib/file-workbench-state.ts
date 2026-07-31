import type { FileDocument, WorkspaceFileReadResult } from '../../../shared/contracts'
import { activateTab, addTab, removeTab, type WorkspaceLayout } from './workbench-layout'
import {
  createWorkbenchTab,
  documentKey,
  fileTabId,
  initialWorkbenchRegionId,
  removeWorkbenchRegion,
  tabGroupForTab,
  remapLayoutTabIds,
  titleWorkbenchSurface,
  workbenchSurfaces,
  type FileWorkbenchSurface,
  type WorkbenchTab
} from './workbench-tabs'
import { isPathWithinSubtree, remapPathWithinSubtree } from './workspace-paths'
import {
  deleteFileExplorerViewPaths,
  renameFileExplorerViewPaths,
  type FileExplorerViewState
} from './file-explorer-selection'

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
  fileExplorerStates: Record<string, FileExplorerViewState | undefined>
}

export type FileDocumentIssue =
  | { kind: 'changed'; observed: FileDocument }
  | { kind: 'deleted' }
  | { kind: 'read-error'; code: string; message: string }
  | { kind: 'write-error'; code: string; message: string }

export type FileRenameProjectionCollision = {
  owner: 'tab' | 'document' | 'region'
  path: string
}

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
  preferredTabGroupId?: string,
  topicId?: string
): FileWorkbenchState {
  const layout = state.layouts[workspaceId]
  if (!layout) return state
  const tabId = fileTabId(workspaceId, path)
  const key = documentKey(workspaceId, path)
  const alreadyOpen = Boolean(state.documents[key])
  const existingTabGroupId = tabGroupForTab(layout, tabId)
  const targetTabGroupId = existingTabGroupId ?? preferredTabGroupId ?? layout.activeGroupId
  const existingTab = state.tabs[tabId]
  const tab = existingTab ?? (() => {
    const surface: FileWorkbenchSurface = {
      regionId: initialWorkbenchRegionId(tabId),
      kind: 'file',
      workspaceId,
      path
    }
    const createdTab = createWorkbenchTab(tabId, surface)
    return topicId ? { ...createdTab, topicId } : createdTab
  })()
  return {
    ...state,
    documents: { ...state.documents, [key]: alreadyOpen ? state.documents[key]! : document },
    documentGenerations: { ...state.documentGenerations, [key]: state.documentGenerations[key] ?? 0 },
    documentObservationGenerations: {
      ...state.documentObservationGenerations,
      [key]: state.documentObservationGenerations[key] ?? 0
    },
    documentIssues: alreadyOpen ? state.documentIssues : withoutIssue(state.documentIssues, key),
    tabs: { ...state.tabs, [tab.id]: tab },
    lastActiveFileByWorkspace: { ...state.lastActiveFileByWorkspace, [workspaceId]: path },
    layouts: {
      ...state.layouts,
      [workspaceId]: existingTabGroupId
        ? activateTab(layout, targetTabGroupId, tabId)
        : addTab(layout, targetTabGroupId, tabId)
    }
  }
}

/**
 * Attach a document to a file surface that is already on the board.
 *
 * `reduceFileOpened` answers "the user opened this file", so it also activates the Tab and sets the
 * Workspace's last-active file — correct for a click, wrong for a surface that is merely coming back
 * on screen. A restored file Region already sits exactly where the user left it and only lacks its
 * content; activating it would reorder the board (with many restored Tabs, the last one loaded would
 * win the active slot) and rewrite last-active to a file nobody chose.
 *
 * So this writes the document keys and nothing else. It requires the Tab to exist: a document with no
 * surface behind it is unreachable state, and creating the surface here would duplicate the one act
 * `reduceFileOpened` owns.
 */
export function reduceDocumentAttached(
  state: FileWorkbenchState,
  workspaceId: string,
  path: string,
  document: FileDocument
): FileWorkbenchState {
  const key = documentKey(workspaceId, path)
  if (state.documents[key]) return state
  if (!state.tabs[fileTabId(workspaceId, path)]) return state
  return {
    ...state,
    documents: { ...state.documents, [key]: document },
    documentGenerations: { ...state.documentGenerations, [key]: state.documentGenerations[key] ?? 0 },
    documentObservationGenerations: {
      ...state.documentObservationGenerations,
      [key]: state.documentObservationGenerations[key] ?? 0
    },
    documentIssues: withoutIssue(state.documentIssues, key)
  }
}

/**
 * Record why a persisted file surface could not be loaded, for a surface that has no document yet.
 *
 * `reduceDocumentRead` owns this for an OPEN document and returns state unchanged when there is none
 * (`!current`), which is exactly the restore case: the surface is on the board, the document never
 * loaded. Without somewhere to put the reason, `EditorPane` can only fall back to its generic
 * unavailable state, so "this file was deleted while you were away" and "reading it failed" look
 * identical — and the pane has no way to know it should stop retrying.
 *
 * The issue kinds are the existing ones, deliberately: a file deleted while the app was closed is the
 * same fact as one deleted while open, and it should reach the same failure state (which already
 * offers Reveal, falling back to the nearest surviving ancestor) rather than a second, restore-only one.
 */
export function reduceDocumentLoadFailed(
  state: FileWorkbenchState,
  workspaceId: string,
  path: string,
  issue: FileDocumentIssue
): FileWorkbenchState {
  const key = documentKey(workspaceId, path)
  if (state.documents[key]) return state
  if (!state.tabs[fileTabId(workspaceId, path)]) return state
  return { ...state, documentIssues: { ...state.documentIssues, [key]: issue } }
}

export function reduceDocumentContent(
  state: FileWorkbenchState,
  tabId: string,
  content: string,
  regionId?: string
): FileWorkbenchState {
  const tab = state.tabs[tabId]
  if (!tab) return state
  const surface = regionId ? tab.regions[regionId] : titleWorkbenchSurface(tab)
  if (surface?.kind !== 'file') return state
  const key = documentKey(surface.workspaceId, surface.path)
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
  const observedConflictIsSavedRevision = issue?.kind === 'changed' && issue.observed.revision === revision
  const observedConflictWasCaptured =
    (state.documentObservationGenerations[key] ?? 0) === savedObservationGeneration && (
      (issue?.kind === 'changed' && issue.observed.revision === expectedRevision) ||
      (issue?.kind === 'deleted' && expectedRevision === null)
    )
  const clearsIssue = issue?.kind === 'write-error' || observedConflictIsSavedRevision || observedConflictWasCaptured
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
  if (result.status === 'deleted') return {
    ...state,
    documentObservationGenerations,
    documentIssues: { ...state.documentIssues, [key]: { kind: 'deleted' } }
  }
  // An open file replaced on disk by a directory can no longer be read as a document. There is no
  // dedicated issue kind and inventing one buys nothing here, so surface it through the read-error
  // channel. openFile intercepts a directory before a document is ever created, so this only guards
  // the refresh of an already-open document.
  if (result.status === 'directory') return {
    ...state,
    documentObservationGenerations,
    documentIssues: {
      ...state.documentIssues,
      [key]: { kind: 'read-error', code: 'WORKSPACE_PATH_IS_DIRECTORY', message: 'Workspace path is now a directory' }
    }
  }
  if (result.status === 'error') return {
    ...state,
    documentObservationGenerations,
    documentIssues: { ...state.documentIssues, [key]: { kind: 'read-error', code: result.code, message: result.message } }
  }
  if (result.document.revision === current.revision) {
    const issue = state.documentIssues[key]
    const clearsIssue = issue?.kind === 'changed' || issue?.kind === 'deleted' || issue?.kind === 'read-error'
    const matchesCurrentContent = result.document.content === current.content
    return {
      ...state,
      documentObservationGenerations,
      ...(matchesCurrentContent
        ? { dirtyDocuments: { ...state.dirtyDocuments, [key]: false } }
        : {}),
      ...(clearsIssue ? { documentIssues: withoutIssue(state.documentIssues, key) } : {})
    }
  }
  if (state.dirtyDocuments[key]) return {
    ...state,
    documentObservationGenerations,
    documentIssues: { ...state.documentIssues, [key]: { kind: 'changed', observed: result.document } }
  }
  return {
    ...state,
    documentObservationGenerations,
    documents: { ...state.documents, [key]: result.document },
    dirtyDocuments: { ...state.dirtyDocuments, [key]: false },
    documentGenerations: { ...state.documentGenerations, [key]: (state.documentGenerations[key] ?? 0) + 1 },
    documentIssues: withoutIssue(state.documentIssues, key)
  }
}

export function reduceDocumentReloaded(state: FileWorkbenchState, workspaceId: string, path: string, document: FileDocument): FileWorkbenchState {
  const key = documentKey(workspaceId, path)
  if (!state.documents[key]) return state
  return {
    ...state,
    documents: { ...state.documents, [key]: document },
    dirtyDocuments: { ...state.dirtyDocuments, [key]: false },
    documentGenerations: { ...state.documentGenerations, [key]: (state.documentGenerations[key] ?? 0) + 1 },
    documentIssues: withoutIssue(state.documentIssues, key)
  }
}

export function reduceDocumentSaving(state: FileWorkbenchState, workspaceId: string, path: string, saving: boolean): FileWorkbenchState {
  const key = documentKey(workspaceId, path)
  return {
    ...state,
    savingDocuments: { ...state.savingDocuments, [key]: saving },
    ...(saving && state.documentIssues[key]?.kind === 'write-error'
      ? { documentIssues: withoutIssue(state.documentIssues, key) }
      : {})
  }
}

export function reduceDocumentWriteError(state: FileWorkbenchState, workspaceId: string, path: string, code: string, message: string): FileWorkbenchState {
  const key = documentKey(workspaceId, path)
  return {
    ...state,
    savingDocuments: { ...state.savingDocuments, [key]: false },
    documentIssues: { ...state.documentIssues, [key]: { kind: 'write-error', code, message } }
  }
}

export function reconcileWorkbenchFileProjection(
  state: FileWorkbenchState,
  topology: Pick<FileWorkbenchState, 'tabs' | 'layouts'>
): FileWorkbenchState {
  const documents = { ...state.documents }
  const dirtyDocuments = { ...state.dirtyDocuments }
  const documentGenerations = { ...state.documentGenerations }
  const documentObservationGenerations = { ...state.documentObservationGenerations }
  const documentIssues = { ...state.documentIssues }
  const savingDocuments = { ...state.savingDocuments }
  const openDocumentKeys = new Set(Object.values(topology.tabs).flatMap((tab) => (
    workbenchSurfaces(tab).flatMap((surface) => (
      surface.kind === 'file' ? [documentKey(surface.workspaceId, surface.path)] : []
    ))
  )))
  for (const key of Object.keys(documents)) {
    if (!openDocumentKeys.has(key)) delete documents[key]
  }
  for (const key of Object.keys(dirtyDocuments)) {
    if (!openDocumentKeys.has(key)) delete dirtyDocuments[key]
  }
  for (const collection of [documentGenerations, documentObservationGenerations, documentIssues, savingDocuments]) {
    for (const key of Object.keys(collection)) {
      if (!openDocumentKeys.has(key)) delete collection[key]
    }
  }
  return {
    ...state,
    tabs: topology.tabs,
    layouts: topology.layouts,
    documents,
    dirtyDocuments,
    documentGenerations,
    documentObservationGenerations,
    documentIssues,
    savingDocuments,
    lastActiveFileByWorkspace: Object.fromEntries(Object.entries(
      state.lastActiveFileByWorkspace
    ).map(([workspaceId, path]) => [
      workspaceId,
      path && openDocumentKeys.has(documentKey(workspaceId, path)) ? path : undefined
    ]))
  }
}

export function reduceFileRename(
  state: FileWorkbenchState,
  workspaceId: string,
  path: string,
  nextPath: string
): FileWorkbenchState {
  const affectedTabs = Object.values(state.tabs).flatMap((tab) => {
    const surfaces = workbenchSurfaces(tab).filter((surface): surface is FileWorkbenchSurface => (
      surface.kind === 'file' &&
      surface.workspaceId === workspaceId &&
      isPathWithinSubtree(surface.path, path)
    ))
    return surfaces.length > 0 ? [{ tab, surfaces }] : []
  })
  const replacements = new Map(
    affectedTabs.flatMap(({ tab }) => {
      const titleSurface = titleWorkbenchSurface(tab)
      return titleSurface.kind === 'file' &&
        titleSurface.workspaceId === workspaceId &&
        isPathWithinSubtree(titleSurface.path, path)
        ? [[tab.id, fileTabId(workspaceId, remapPathWithinSubtree(titleSurface.path, path, nextPath))] as const]
        : []
    })
  )
  const tabs = { ...state.tabs }
  const documents = { ...state.documents }
  const dirtyDocuments = { ...state.dirtyDocuments }
  const documentGenerations = { ...state.documentGenerations }
  const documentObservationGenerations = { ...state.documentObservationGenerations }
  const documentIssues = { ...state.documentIssues }
  const savingDocuments = { ...state.savingDocuments }
  for (const { tab, surfaces } of affectedTabs) {
    const nextId = replacements.get(tab.id) ?? tab.id
    delete tabs[tab.id]
    tabs[nextId] = {
      ...tab,
      id: nextId,
      regions: Object.fromEntries(Object.entries(tab.regions).map(([regionId, surface]) => [
        regionId,
        surfaces.includes(surface as FileWorkbenchSurface)
          ? {
              ...surface,
              path: remapPathWithinSubtree((surface as FileWorkbenchSurface).path, path, nextPath)
            }
          : surface
      ]))
    }
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
  for (const collection of [documentGenerations, documentObservationGenerations]) {
    for (const [key, value] of Object.entries(collection)) {
      if (!key.startsWith(documentPrefix)) continue
      const documentPath = key.slice(documentPrefix.length)
      if (!isPathWithinSubtree(documentPath, path)) continue
      delete collection[key]
      collection[documentKey(workspaceId, remapPathWithinSubtree(documentPath, path, nextPath))] = value
    }
  }
  for (const [key, issue] of Object.entries(documentIssues)) {
    if (!key.startsWith(documentPrefix)) continue
    const documentPath = key.slice(documentPrefix.length)
    if (!isPathWithinSubtree(documentPath, path)) continue
    const renamedPath = remapPathWithinSubtree(documentPath, path, nextPath)
    delete documentIssues[key]
    documentIssues[documentKey(workspaceId, renamedPath)] = issue?.kind === 'changed'
      ? {
          ...issue,
          observed: {
            ...issue.observed,
            path: remapPathWithinSubtree(issue.observed.path, path, nextPath)
          }
        }
      : issue
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
    },
    fileExplorerStates: state.fileExplorerStates[workspaceId]
      ? {
          ...state.fileExplorerStates,
          [workspaceId]: renameFileExplorerViewPaths(state.fileExplorerStates[workspaceId], path, nextPath)
        }
      : state.fileExplorerStates
  }
}

export function findFileRenameProjectionCollision(
  state: FileWorkbenchState,
  workspaceId: string,
  path: string,
  nextPath: string
): FileRenameProjectionCollision | null {
  const tabs = Object.values(state.tabs)
  const affectedTitleTabs = tabs.flatMap((tab) => {
    const titleSurface = titleWorkbenchSurface(tab)
    return (
      titleSurface.kind !== 'file' ||
      titleSurface.workspaceId !== workspaceId ||
      !isPathWithinSubtree(titleSurface.path, path)
    ) ? [] : [{ tab, titleSurface }]
  })
  const affectedTabIds = new Set(affectedTitleTabs.map(({ tab }) => tab.id))
  for (const { tab, titleSurface } of affectedTitleTabs) {
    const renamedPath = remapPathWithinSubtree(titleSurface.path, path, nextPath)
    const nextTabId = fileTabId(workspaceId, renamedPath)
    if (nextTabId !== tab.id && state.tabs[nextTabId] && !affectedTabIds.has(nextTabId)) {
      return { owner: 'tab', path: renamedPath }
    }
  }

  const sourceDocumentKeys = new Set<string>()
  const documentPrefix = `${workspaceId}\0`
  const documentCollections = [
    state.documents,
    state.dirtyDocuments,
    state.documentGenerations,
    state.documentObservationGenerations,
    state.documentIssues,
    state.savingDocuments
  ]
  for (const collection of documentCollections) {
    for (const key of Object.keys(collection)) {
      if (!key.startsWith(documentPrefix)) continue
      const documentPath = key.slice(documentPrefix.length)
      if (isPathWithinSubtree(documentPath, path)) sourceDocumentKeys.add(key)
    }
  }
  for (const key of sourceDocumentKeys) {
    const documentPath = key.slice(documentPrefix.length)
    const renamedPath = remapPathWithinSubtree(documentPath, path, nextPath)
    const nextKey = documentKey(workspaceId, renamedPath)
    if (documentCollections.some((collection) => nextKey in collection) && !sourceDocumentKeys.has(nextKey)) {
      return { owner: 'document', path: renamedPath }
    }
  }

  const affectedRegions = new Set<string>()
  const occupiedRegions = new Map<string, string>()
  for (const tab of Object.values(state.tabs)) {
    for (const surface of workbenchSurfaces(tab)) {
      if (surface.kind !== 'file' || surface.workspaceId !== workspaceId) continue
      const regionOwner = `${tab.id}\0${surface.regionId}`
      if (isPathWithinSubtree(surface.path, path)) {
        affectedRegions.add(regionOwner)
      } else {
        occupiedRegions.set(surface.path, regionOwner)
      }
    }
  }
  for (const tab of Object.values(state.tabs)) {
    for (const surface of workbenchSurfaces(tab)) {
      if (surface.kind !== 'file' || surface.workspaceId !== workspaceId) continue
      const regionOwner = `${tab.id}\0${surface.regionId}`
      if (!affectedRegions.has(regionOwner)) continue
      const renamedPath = remapPathWithinSubtree(surface.path, path, nextPath)
      if (occupiedRegions.has(renamedPath)) return { owner: 'region', path: renamedPath }
    }
  }
  return null
}

export function reduceFileDelete(
  state: FileWorkbenchState,
  workspaceId: string,
  path: string
): FileWorkbenchState {
  const affectedTabs = Object.values(state.tabs).flatMap((tab) => {
    const regionIds = workbenchSurfaces(tab).flatMap((surface) => (
      surface.kind === 'file' &&
      surface.workspaceId === workspaceId &&
      isPathWithinSubtree(surface.path, path)
        ? [surface.regionId]
        : []
    ))
    return regionIds.length > 0 ? [{ tab, regionIds }] : []
  })
  const tabs = { ...state.tabs }
  let layout = state.layouts[workspaceId]
  for (const { tab, regionIds } of affectedTabs) {
    let nextTab: WorkbenchTab | null = tab
    for (const regionId of regionIds) {
      if (!nextTab) break
      nextTab = removeWorkbenchRegion(nextTab, regionId)
    }
    if (nextTab) {
      tabs[tab.id] = nextTab
    } else {
      delete tabs[tab.id]
      if (layout) {
        const groupId = tabGroupForTab(layout, tab.id)
        if (groupId) layout = removeTab(layout, groupId, tab.id)
      }
    }
  }
  const documents = { ...state.documents }
  const dirtyDocuments = { ...state.dirtyDocuments }
  const documentGenerations = { ...state.documentGenerations }
  const documentObservationGenerations = { ...state.documentObservationGenerations }
  const documentIssues = { ...state.documentIssues }
  const savingDocuments = { ...state.savingDocuments }
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
    },
    fileExplorerStates: state.fileExplorerStates[workspaceId]
      ? {
          ...state.fileExplorerStates,
          [workspaceId]: deleteFileExplorerViewPaths(state.fileExplorerStates[workspaceId], path)
        }
      : state.fileExplorerStates
  }
}
