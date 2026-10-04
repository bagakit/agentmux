import type { NotesResourceChange } from '@agentmux/core/notebook-store'
import { api } from './api'
import { useLauncherState } from './launcher-state'
import { NOTES_WORKSPACE_ID } from '../../../shared/notes-library'
import type { SpaceZoneBindings } from '../../../shared/space-addresses'
import type { NoteCreationReceipt } from './note-creation'
import type { FileWorkbenchState } from './file-workbench-state'
/** Relocation changes file resources, preserving the original entities, drafts and layout. */
export function reconcileNotesStorageResources<T extends FileWorkbenchState>(state: T, changes: readonly NotesResourceChange[], directoryChanges: readonly { from: string; to: string }[] = []): T {
  let next = state
  for (const change of changes) {
    const fromKey = change.from.workspaceId + '\0' + change.from.path, toKey = change.to.workspaceId + '\0' + change.to.path
    const conflict = fromKey !== toKey && next.documents[fromKey] && next.documents[toKey] && next.documents[fromKey]!.content !== next.documents[toKey]!.content
    const affected = Object.values(next.tabs).filter(tab => Object.values(tab.regions).some(surface => surface.kind === 'file' && surface.workspaceId === change.from.workspaceId && surface.path === change.from.path))
    if (!affected.length && !Object.hasOwn(next.documents, fromKey)) continue
    const patch: Record<string, unknown> = { tabs: { ...next.tabs } }
    for (const tab of affected) (patch.tabs as typeof next.tabs)[tab.id] = { ...tab, regions: Object.fromEntries(Object.entries(tab.regions).map(([id, surface]) => [id, surface.kind === 'file' && surface.workspaceId === change.from.workspaceId && surface.path === change.from.path ? { ...surface, workspaceId: change.to.workspaceId, path: change.to.path } : surface])) }
    for (const field of ['documents', 'dirtyDocuments', 'documentGenerations', 'documentObservationGenerations', 'documentIssues', 'savingDocuments', 'retainedDocumentDrafts'] as const) {
      const collection = { ...next[field] } as Record<string, unknown>
      if (!conflict && fromKey !== toKey && Object.hasOwn(collection, fromKey)) { collection[toKey] = collection[fromKey]; delete collection[fromKey] }
      if (field === 'documents' && collection[toKey]) collection[toKey] = { ...(collection[toKey] as object), workspaceId: change.to.workspaceId, path: change.to.path }
      patch[field] = collection
    }
    if (conflict) {
      const retained = patch.retainedDocumentDrafts as Record<string, typeof next.documents[string][]>
      const alternatives = [...(retained[toKey] ?? []), ...(retained[fromKey] ?? [])]
      const source = { ...next.documents[fromKey]!, path: change.to.path }
      if (!alternatives.some(draft => draft.content === source.content)) alternatives.push(source)
      retained[toKey] = alternatives
      for (const field of ['documents', 'dirtyDocuments', 'documentGenerations', 'documentObservationGenerations', 'documentIssues', 'savingDocuments', 'retainedDocumentDrafts'] as const) delete (patch[field] as Record<string, unknown>)[fromKey]
      ;(patch.dirtyDocuments as typeof next.dirtyDocuments)[toKey] = true
      // A retained buffer is not a disk observation. Normal read/write conflict facts stay intact.
    }
    if (!conflict) {
      const issues = patch.documentIssues as typeof next.documentIssues
      const issue = issues[toKey]
      if (issue?.kind === 'write-unknown' && issue.attempted.resource.hostId === change.from.hostId && issue.attempted.resource.path === change.from.workspacePath) {
        issues[toKey] = { ...issue, attempted: { ...issue.attempted, resource: { hostId: change.to.hostId, path: change.to.workspacePath } } }
      }
      if (next.savingDocuments[fromKey]) {
        // Store invalidates old write receipts at this resource boundary. Its busy flag must
        // not survive that receipt; read the canonical file before making a new save attempt.
        ;(patch.savingDocuments as typeof next.savingDocuments)[toKey] = false
        if (!issue || issue.kind === 'write-error') issues[toKey] = { kind: 'read-error', code: 'NOTE_SAVE_RELOCATED',
          message: 'The Note directory changed during this save. Its outcome is unconfirmed; retry reading the current file before saving again. Your draft is kept.' }
      }
    }
    next = { ...next, ...patch }
  }
  const bindings = (next as T & { spaceZoneBindings?: SpaceZoneBindings }).spaceZoneBindings
  if (bindings && directoryChanges.length) {
    const revised = { ...bindings }
    for (const [id, binding] of Object.entries(bindings)) {
      if (binding.workspaceId !== NOTES_WORKSPACE_ID) continue
      let originalPath = binding.directoryPath
      if (!originalPath) { try { const context = JSON.parse(binding.spaceId); if (Array.isArray(context) && context[0] === 'local' && typeof context[1] === 'string') originalPath = context[1] } catch { /* Opaque identities are retained. */ } }
      if (!originalPath) continue
      let directoryPath = originalPath
      for (const move of directoryChanges) if (directoryPath === move.from || directoryPath.startsWith(move.from + '/')) directoryPath = move.to + directoryPath.slice(move.from.length)
      if (directoryPath !== originalPath) revised[id] = { ...binding, directoryPath }
    }
    next = { ...next, spaceZoneBindings: revised }
  }
  return next
}

/** Preserve the exact creating intent and its unsaved input across a root change. */
export function reconcileNotesCreationReceipt(receipt: NoteCreationReceipt, changes: readonly NotesResourceChange[], directory: string): NoteCreationReceipt {
  const change = changes.find(c => c.noteId === receipt.noteId && c.from.workspaceId === receipt.target.workspaceId && c.from.workspacePath === receipt.target.workspacePath && c.from.path === receipt.path)
  if (!change && receipt.target.workspaceId !== NOTES_WORKSPACE_ID) return receipt
  const to = change?.to ?? { hostId: receipt.target.hostId, workspaceId: receipt.target.workspaceId, workspacePath: directory, path: receipt.path }
  const oldRoot = receipt.target.workspacePath, oldDirectory = receipt.target.directoryPath
  if (to.workspacePath === oldRoot && to.workspaceId === receipt.target.workspaceId && to.path === receipt.path) return receipt
  const directoryPath = oldDirectory === oldRoot ? to.workspacePath : oldDirectory?.startsWith(oldRoot + '/') ? to.workspacePath + oldDirectory.slice(oldRoot.length) : oldDirectory
  return { ...receipt, path: to.path, target: { ...receipt.target, hostId: to.hostId, workspaceId: to.workspaceId, workspacePath: to.workspacePath, directoryPath } }
}
export function reconcileNotesLauncherDrafts(changes: readonly NotesResourceChange[], directory: string): void {
  const original = useLauncherState.getState()
  for (const [id, draft] of Object.entries(original.drafts)) if (draft.noteCreation) {
    const next = reconcileNotesCreationReceipt(draft.noteCreation, changes, directory)
    if (next !== draft.noteCreation) original.setNoteCreation(id, next)
  }
}

export async function reobserveNotesStorageResources(state: FileWorkbenchState, changes: readonly NotesResourceChange[], current: () => FileWorkbenchState = () => state): Promise<void> {
  for (const change of changes) if (Object.values(state.tabs).some(tab => Object.values(tab.regions).some(surface => surface.kind === 'file' && surface.workspaceId === change.to.workspaceId && surface.path === change.to.path))) {
    await api.files.unobserve(change.from.workspaceId, change.from.path)
    if (Object.values(current().tabs).some(tab => Object.values(tab.regions).some(surface => surface.kind === 'file' && surface.workspaceId === change.to.workspaceId && surface.path === change.to.path))) await api.files.observe(change.to.workspaceId, change.to.path)
  }
}
