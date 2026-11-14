import { sameFileEntryIdentity, type FileMutationEffect, type FileReadIdentity, type FileEntryWitness } from '@agentmux/core/files'
import { topicFileDirectory } from './topic-files-address'
import { sameFilesRuntime, type FileMutationLocation } from './source-files-workbench'
import { documentKey, workbenchSurfaces } from './workbench-tabs'
import { findFileRenameProjectionCollision, reduceFileRename, type FileWorkbenchState } from './file-workbench-state'
import { isPathWithinSubtree, remapPathWithinSubtree } from './workspace-paths'
import { hasNoteComposition } from './note-live-merge'
import { hasAdmittedFileSave } from './file-document-bookkeeping'

export type FileEffectDocument = { path: string; document: FileWorkbenchState['documents'][string]; generation: number; views: string }
export type FileEffectProjection = { effect: FileMutationEffect; candidates: FileEffectDocument[]; unconfirmed: FileEffectDocument[]; sourcePath?: string; destinationPath?: string }
const same = sameFileEntryIdentity
const contains = (identity: FileReadIdentity | undefined, source: FileEntryWitness, directory: boolean) => Boolean(identity &&
  (directory ? identity.ancestorWitnesses.some(ancestor => same(ancestor, source)) : same(identity.entry, source)))
const namespace = (left: FileMutationLocation['resource'], right: FileMutationLocation['resource']) =>
  left.hostId === right.hostId && left.workspaceId === right.workspaceId && left.workspacePath === right.workspacePath
function relative(location: FileMutationLocation, resource: FileMutationLocation['resource']): string | undefined {
  if (!namespace(location.resource, resource)) return
  if (location.displayRoot) return resource.zoneId === location.resource.zoneId && resource.zonePath === location.resource.zonePath &&
    isPathWithinSubtree(resource.path, location.displayRoot) ? resource.path : undefined
  const base = location.resource.path === '.' ? '' : location.resource.path
  if (!base) return resource.path === '.' ? '' : resource.path
  return resource.path === base ? '' : resource.path.startsWith(base + '/') ? resource.path.slice(base.length + 1) : undefined
}
/** One snapshot-local topology pass; no per-buffer global scan or retained index. */
function fileViewIndex(state: FileWorkbenchState, workspaceId: string): Map<string, string> {
  const rows = new Map<string, string[][]>()
  for (const tab of Object.values(state.tabs)) for (const surface of workbenchSurfaces(tab)) {
    if (surface.kind !== 'file' || surface.workspaceId !== workspaceId) continue
    const row = rows.get(surface.path) ?? []; row.push([tab.id, surface.regionId]); rows.set(surface.path, row)
  }
  return new Map([...rows].map(([path, row]) => [path, JSON.stringify(row.sort())]))
}

/** Freeze only related presentation buffers before destination observation can await. */
export function captureFileEffect(state: FileWorkbenchState, workspaceId: string, location: FileMutationLocation, effect: FileMutationEffect): FileEffectProjection {
  if (effect.type !== 'path-mutation' || effect.action === 'mkdir' || !effect.receipt.resource || !namespace(location.resource, effect.receipt.resource)) return { effect, candidates: [], unconfirmed: [] }
  const sourcePath = relative(location, effect.receipt.resource), destinationPath = effect.action === 'move' && effect.receipt.destination ? relative(location, effect.receipt.destination) : undefined
  if (sourcePath === undefined) return { effect, candidates: [], unconfirmed: [] }
  const source = effect.request.expected.entry, prefix = workspaceId + '\0', views = fileViewIndex(state, workspaceId)
  const unconfirmed: FileEffectDocument[] = []
  const candidates = Object.entries(state.documents).flatMap(([key, document]) => {
    if (!key.startsWith(prefix)) return []
    const path = key.slice(prefix.length)
    const origin = document.readSource
    if (!isPathWithinSubtree(path, sourcePath)) return []
    // A Main Topic draft is not an unconfirmed buffer in a different selected Source.
    if (!origin && !location.displayRoot && topicFileDirectory(workspaceId, path) &&
        (location.resource.workspaceId !== workspaceId || location.resource.workspacePath !== location.workspace.path ||
         location.resource.hostId !== location.workspace.hostId || location.target.hostId !== location.workspace.hostId || location.resource.path !== '.')) return []
    if (origin && (!sameFilesRuntime(origin.target, location.target) || relative(location, origin.resource) !== path)) return []
    const frozen = { path, document, generation: state.documentGenerations[key] ?? 0, views: views.get(path) ?? '[]' }
    if ((!origin && !location.displayRoot) || !document.readIdentity || state.savingDocuments[key] || hasAdmittedFileSave(key) || hasNoteComposition(key)) {
      unconfirmed.push(frozen)
      return []
    }
    return contains(document.readIdentity, source.witness, source.kind === 'directory') ? [frozen] : []
  })
  return { effect, sourcePath, ...(destinationPath === undefined ? {} : { destinationPath }), candidates, unconfirmed }
}

/** No filesystem absence, path prefix, equal bytes or old input can authorize rebasing a View. */
export function applyFileEffect(state: FileWorkbenchState, workspaceId: string, held: FileEffectProjection,
  destinations: ReadonlyMap<string, { identity: FileReadIdentity; resource: FileMutationLocation['resource']; query: NonNullable<FileEffectDocument['document']['readSource']>['query'] }> = new Map()): FileWorkbenchState {
  const effect = held.effect
  if (effect.type !== 'path-mutation' || effect.action === 'mkdir') return state
  if (effect.receipt.result.filesystem !== (effect.action === 'move' ? 'moved' : 'deleted')) return state
  let next = state
  const views = fileViewIndex(state, workspaceId)
  for (const candidate of held.unconfirmed) {
    const key = documentKey(workspaceId, candidate.path)
    if (next.documents[key] !== candidate.document || (next.documentGenerations[key] ?? 0) !== candidate.generation || (views.get(candidate.path) ?? '[]') !== candidate.views || next.documentIssues[key]) continue
    next = { ...next, documentIssues: { ...next.documentIssues, [key]: { kind: 'read-error', code: 'FILE_EFFECT_SOURCE_UNCONFIRMED',
      message: `A file mutation was confirmed, but this buffer's original identity is unavailable. Its contents and View are retained. Check original operation ${effect.request.operationId}.` } } }
  }
  for (const candidate of held.candidates) {
    const key = documentKey(workspaceId, candidate.path)
    // Final transaction consumes the same body/generation; new input and new Views remain intact.
    if (next.documents[key] !== candidate.document || (next.documentGenerations[key] ?? 0) !== candidate.generation ||
      (views.get(candidate.path) ?? '[]') !== candidate.views || hasNoteComposition(key) || hasAdmittedFileSave(key) || next.savingDocuments[key]) {
      const current = next.documents[key]
      // Only the same original Source/file lineage receives a late-projection notice.
      // A replacement document or another Source never inherits this operation.
      if (current?.readIdentity && same(current.readIdentity.entry, candidate.document.readIdentity!.entry) &&
        JSON.stringify(current.readSource) === JSON.stringify(candidate.document.readSource) && !next.documentIssues[key]) next = {
          ...next, documentIssues: { ...next.documentIssues, [key]: { kind: 'read-error', code: 'FILE_EFFECT_PROJECTION_CHANGED',
            message: `The original ${effect.action} was confirmed, but this editor changed while its result settled. Its complete contents and View are kept. Check original operation ${effect.request.operationId}.` } } }
      continue
    }
    if (effect.action === 'delete') {
      next = { ...next, documentIssues: { ...next.documentIssues, [key]: { kind: 'deleted' } },
        documentObservationGenerations: { ...next.documentObservationGenerations, [key]: (next.documentObservationGenerations[key] ?? 0) + 1 } }
      continue
    }
    if (held.sourcePath === undefined || held.destinationPath === undefined) continue
    const to = remapPathWithinSubtree(candidate.path, held.sourcePath, held.destinationPath)
    const destination = destinations.get(candidate.path), observed = destination?.identity, prior = candidate.document.readIdentity!
    if (!observed || !same(observed.entry, prior.entry) || effect.request.expected.entry.kind === 'directory' &&
        !observed.ancestorWitnesses.some(ancestor => same(ancestor, effect.request.expected.entry.witness))) continue
    if (findFileRenameProjectionCollision(next, workspaceId, candidate.path, to)) continue
    next = reduceFileRename(next, workspaceId, candidate.path, to)
    const destinationKey = documentKey(workspaceId, to), moved = next.documents[destinationKey]
    if (moved) next = { ...next, documents: { ...next.documents, [destinationKey]: { ...moved, readIdentity: observed,
      ...(candidate.document.readSource ? { readSource: { target: candidate.document.readSource.target, resource: destination!.resource, query: destination!.query } } : {}) } } }
  }
  return next
}
