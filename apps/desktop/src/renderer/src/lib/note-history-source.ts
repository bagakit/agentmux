import type { FileHistoryParams } from '@agentmux/core/files'
import type { NoteFileHistoryTarget } from '../../../shared/note-file-editing'
import { api } from './api'
import { confirmNoteHistoryTarget, noteResourceReadParams } from './note-history-target'
import { scratchTopicsForConfig } from './scratch-topic-snapshots'
import type { AppState } from '../store'
import type { FileDocument } from '../../../shared/contracts'

/** The routing witness stays client-side; only the original Core params cross its boundary. */
export function noteHistoryCoreTarget(target: NoteFileHistoryTarget) {
  const { source: _source, ...params } = target
  return params
}
export async function readNoteFileHistory(target: NoteFileHistoryTarget, page: Pick<FileHistoryParams, 'limit' | 'before' | 'eventId' | 'includeContent'> = {}) {
  const params = { ...noteHistoryCoreTarget(target), ...page }
  return target.source ? (await api.sourceFiles.call(target.source.target, 'file.history', params)).result : await api.files.historyPublic(params)
}

/** This is the old Main owner only. Its alias/path carries no Source write authority. */
export async function originalMainNoteHistory(state: AppState, legacy: NonNullable<FileDocument['legacyMainNote']>): Promise<NoteFileHistoryTarget> {
  if (legacy.target) return noteHistoryCoreTarget(legacy.target)
  const params = noteResourceReadParams(state, scratchTopicsForConfig(state.config, state.scratchTopicSnapshots) ?? [], legacy.resource)
  const observed = await api.files.readPublic(params)
  if (observed.result.status === 'deleted' && legacy.provenance) {
    // History remains read-only. Its own public owner validates the exact Note/resource;
    // no fabricated body/header or Source attribution is used to grant a write.
    if (observed.resource && ['hostId', 'workspaceId', 'workspacePath', 'path'].every(key => observed.resource![key as keyof typeof legacy.resource] === legacy.resource[key as keyof typeof legacy.resource])) return {
      ...params, expectedResource: observed.resource, noteId: legacy.noteId
    }
  }
  return confirmNoteHistoryTarget(params, legacy.noteId, observed, legacy.resource.path).target
}
