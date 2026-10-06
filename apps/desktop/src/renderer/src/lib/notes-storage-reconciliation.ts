import type { NotesResourceChange } from '@agentmux/core/notebook-store'
import { api } from './api'
import { useLauncherState } from './launcher-state'
import { NOTES_WORKSPACE_ID } from '../../../shared/notes-library'
import type { SpaceZoneBindings } from '../../../shared/space-addresses'
import type { NoteCreationReceipt } from './note-creation'
import type { FileWorkbenchState } from './file-workbench-state'
import type { FileDocument } from '../../../shared/contracts'
import { convertLegacyNoteDraft } from '@agentmux/client-ui/note/note-legacy-draft'
import { newNoteDocument } from '@agentmux/client-ui/note/note-document'

function convertedDocument(document: FileDocument, change: NotesResourceChange, unknown?: Extract<FileWorkbenchState['documentIssues'][string], { kind: 'write-unknown' }>): FileDocument {
  if (!change.conversion) return document
  const converted = convertLegacyNoteDraft(document.content, change.noteId)
  if (converted.status === 'unchanged') return document
  return { ...document, ...(converted.status === 'converted' ? { content: converted.content } : {}),
    revision: converted.status === 'converted' && !unknown && document.revision === change.conversion.sourceRevision ? change.conversion.targetRevision : document.revision,
    noteConversion: document.noteConversion ?? { originalContent: document.content, originalRevision: document.revision, source: change.from,
      ...(unknown ? { unconfirmedWrite: structuredClone(unknown.attempted) } : {}) } }
}
/** Relocation changes file resources, preserving the original entities, drafts and layout. */
export function reconcileNotesStorageResources<T extends FileWorkbenchState>(state: T, changes: readonly NotesResourceChange[], directoryChanges: readonly { from: string; to: string }[] = []): T {
  let next = state
  for (const change of changes) {
    const fromKey = change.from.workspaceId + '\0' + change.from.path, toKey = change.to.workspaceId + '\0' + change.to.path
    const conflict = fromKey !== toKey && next.documents[fromKey] && next.documents[toKey] && next.documents[fromKey]!.content !== next.documents[toKey]!.content
    const affected = Object.values(next.tabs).filter(tab => Object.values(tab.regions).some(surface => surface.kind === 'file' && surface.workspaceId === change.from.workspaceId && surface.path === change.from.path))
    if (!affected.length && !Object.hasOwn(next.documents, fromKey)) continue
    const issue = next.documentIssues[fromKey]
    const unknown = issue?.kind === 'write-unknown' ? issue : undefined
    const patch: Record<string, unknown> = { tabs: { ...next.tabs } }
    for (const tab of affected) (patch.tabs as typeof next.tabs)[tab.id] = { ...tab, regions: Object.fromEntries(Object.entries(tab.regions).map(([id, surface]) => [id, surface.kind === 'file' && surface.workspaceId === change.from.workspaceId && surface.path === change.from.path ? { ...surface, workspaceId: change.to.workspaceId, path: change.to.path } : surface])) }
    for (const field of ['documents', 'dirtyDocuments', 'documentGenerations', 'documentObservationGenerations', 'documentIssues', 'savingDocuments', 'retainedDocumentDrafts'] as const) {
      const collection = { ...next[field] } as Record<string, unknown>
      if (!conflict && fromKey !== toKey && Object.hasOwn(collection, fromKey)) { collection[toKey] = collection[fromKey]; delete collection[fromKey] }
      if (field === 'documents' && collection[toKey]) collection[toKey] = { ...(collection[toKey] as object), workspaceId: change.to.workspaceId, path: change.to.path }
      if (field === 'documents' && collection[toKey]) collection[toKey] = convertedDocument(collection[toKey] as FileDocument, change, conflict ? next.documentIssues[toKey]?.kind === 'write-unknown' ? next.documentIssues[toKey] as typeof unknown : undefined : unknown)
      if (field === 'retainedDocumentDrafts' && collection[toKey]) collection[toKey] = (collection[toKey] as FileDocument[]).map(document => convertedDocument(document, change))
      patch[field] = collection
    }
    if (conflict) {
      const retained = patch.retainedDocumentDrafts as Record<string, typeof next.documents[string][]>
      const alternatives = [...(retained[toKey] ?? []), ...(retained[fromKey] ?? [])]
      const source = { ...convertedDocument(next.documents[fromKey]!, change, unknown), path: change.to.path }
      if (!alternatives.some(draft => draft.content === source.content)) alternatives.push(source)
      retained[toKey] = alternatives
      for (const field of ['documents', 'dirtyDocuments', 'documentGenerations', 'documentObservationGenerations', 'documentIssues', 'savingDocuments', 'retainedDocumentDrafts'] as const) delete (patch[field] as Record<string, unknown>)[fromKey]
      ;(patch.dirtyDocuments as typeof next.dirtyDocuments)[toKey] = true
      // A retained buffer is not a disk observation. Normal read/write conflict facts stay intact.
    }
    if (!conflict) {
      const issues = patch.documentIssues as typeof next.documentIssues
      const issue = issues[toKey]
      if (!change.conversion && issue?.kind === 'write-unknown' && issue.attempted.resource.hostId === change.from.hostId && issue.attempted.resource.path === change.from.workspacePath) {
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
    if (change.conversion && next.documents[fromKey]) {
      const result = convertLegacyNoteDraft(next.documents[fromKey]!.content, change.noteId)
      if (result.status === 'unconfirmed') (patch.documentIssues as typeof next.documentIssues)[toKey] = unknown ? { ...unknown, checkMessage: result.message + ' The original draft and save attempt are retained.' }
        : { kind: 'read-error', code: 'NOTE_DRAFT_CONVERSION_UNCONFIRMED', message: result.message + ' The original draft is retained in Source; conversion can be retried after the exact Note identity is confirmed.' }
    }
    const revealTargets = (next as T & { documentRevealTargets?: Record<string, unknown> }).documentRevealTargets
    if (revealTargets && fromKey !== toKey && Object.hasOwn(revealTargets, fromKey)) {
      const revised = { ...revealTargets }
      if (!Object.hasOwn(revised, toKey)) revised[toKey] = revised[fromKey]
      delete revised[fromKey]; patch.documentRevealTargets = revised
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
  let current = receipt
  for (const change of changes) {
    if (change.noteId !== current.noteId || change.from.hostId !== current.target.hostId || change.from.workspaceId !== current.target.workspaceId || change.from.workspacePath !== current.target.workspacePath || change.from.path !== current.path) continue
    const oldRoot = current.target.workspacePath, oldDirectory = current.target.directoryPath, to = change.to
    const directoryPath = oldDirectory === oldRoot ? to.workspacePath : oldDirectory?.startsWith(oldRoot + '/') ? to.workspacePath + oldDirectory.slice(oldRoot.length) : oldDirectory
    const legacyConversion = current.legacyConversion ?? (change.conversion ? { path: current.path, target: current.target,
      content: JSON.stringify(newNoteDocument(current.draft, current.noteId, current.blockIds[0]!), null, 2), expectedRevision: null as null,
      ...(current.write ? { write: current.write } : {}) } : undefined)
    current = { ...current, path: to.path, target: { ...current.target, hostId: to.hostId, workspaceId: to.workspaceId, workspacePath: to.workspacePath, directoryPath },
      ...(legacyConversion ? { legacyConversion } : {}) }
  }
  if (current.target.workspaceId !== NOTES_WORKSPACE_ID || current.target.workspacePath === directory) return current
  const oldRoot = current.target.workspacePath, oldDirectory = current.target.directoryPath
  const directoryPath = oldDirectory === oldRoot ? directory : oldDirectory?.startsWith(oldRoot + '/') ? directory + oldDirectory.slice(oldRoot.length) : oldDirectory
  return { ...current, target: { ...current.target, workspacePath: directory, directoryPath } }
}
export function reconcileNotesLauncherDrafts(changes: readonly NotesResourceChange[], directory: string): void {
  const original = useLauncherState.getState()
  for (const [id, draft] of Object.entries(original.drafts)) if (draft.noteCreation) {
    const next = reconcileNotesCreationReceipt(draft.noteCreation, changes, directory)
    if (next !== draft.noteCreation) original.setNoteCreation(id, next)
  }
}

export async function reobserveNotesStorageResources(state: FileWorkbenchState, changes: readonly NotesResourceChange[], current: () => FileWorkbenchState = () => state): Promise<void> {
  const observed = new Set<string>()
  for (const [index, change] of changes.entries()) {
    let destination = change.to
    for (const next of changes.slice(index + 1)) if (next.noteId === change.noteId && (['hostId', 'workspaceId', 'workspacePath', 'path'] as const).every(field => next.from[field] === destination[field])) destination = next.to
    if (!Object.values(state.tabs).some(tab => Object.values(tab.regions).some(surface => surface.kind === 'file' && surface.workspaceId === destination.workspaceId && surface.path === destination.path))) continue
    await api.files.unobserve(change.from.workspaceId, change.from.path)
    const key = destination.workspaceId + '\0' + destination.path
    if (!observed.has(key) && Object.values(current().tabs).some(tab => Object.values(tab.regions).some(surface => surface.kind === 'file' && surface.workspaceId === destination.workspaceId && surface.path === destination.path))) {
      await api.files.observe(destination.workspaceId, destination.path); observed.add(key)
    }
  }
}
