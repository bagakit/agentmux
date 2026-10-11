import { parseFileReadResult, type FileReadParams, type FileReadResult, type FileHistoryParams } from '@agentmux/core/files'
import { readNoteMarkdownHeader } from '@agentmux/core/note-format'
import type { ScratchTopicSnapshot } from '../../../shared/contracts'
import { zoneFileResource } from '../../../shared/zone-file-resource'
import { spatialCatalog, type SpatialWorkbench } from './space-agent-control'

export type NoteHistoryTarget = Omit<FileHistoryParams, 'limit' | 'before' | 'eventId' | 'includeContent'>
export type NoteHistoryRead = { target: NoteHistoryTarget; document: Extract<FileReadResult['result'], { status: 'read' }>['document'] }

/** A candidate from this original File occurrence; only an actual read confirms it. */
export function noteHistoryReadParams(state: SpatialWorkbench, topics: readonly ScratchTopicSnapshot[], tabId: string, regionId: string): FileReadParams {
  const tab = state.tabs[tabId], surface = tab?.regions[regionId]
  const workspace = surface?.kind === 'file' ? state.config?.workspaces.find(item => item.id === surface.workspaceId) : undefined
  if (!tab?.space || surface?.kind !== 'file' || !workspace) throw Error('The original Note file position is unconfirmed. Its file and draft are retained; restore this same position before reading its history.')
  const catalog = spatialCatalog(state, topics), zones = catalog.zones.filter(zone => zone.zoneId === tab.space!.zoneId), zone = zones[0]
  if (zones.length !== 1 || !zone) throw Error('The exact original Note Zone is unconfirmed. The current file and draft are retained.')
  // A Notebook Zone can have a resource context without any display membership.
  // Files accepts that exact Zone independently; only send a confirmed Space relation.
  const spaceId = catalog.bindings.some(binding => binding.zoneId === zone.zoneId && binding.spaceId === tab.space!.spaceId) ? tab.space.spaceId : undefined
  const directory = zoneFileResource(workspace, zone, '', topics)
  const prefix = directory.relativeDirectory ? directory.relativeDirectory + '/' : ''
  if (!surface.path.startsWith(prefix) || surface.path.length === prefix.length) throw Error('This Note file does not belong to the original Zone directory. Its current draft is retained.')
  const path = surface.path.slice(prefix.length), mapped = zoneFileResource(workspace, zone, path, topics)
  if (mapped.path !== surface.path) throw Error('The original Note file path cannot be confirmed in this Zone. Its current draft is retained.')
  return { zoneId: zone.zoneId, ...(spaceId === undefined ? {} : { spaceId }), path,
    expectedResource: { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path } }
}

/** Pin the exact complete public resource and Note identity from the original read. */
export function confirmNoteHistoryTarget(params: FileReadParams, noteId: string, value: FileReadResult, expectedPath: string): NoteHistoryRead {
  const receipt = parseFileReadResult(value, params)
  if (receipt.result.status !== 'read' || receipt.resource === null) throw Error(receipt.result.status === 'unknown' || receipt.result.status === 'error'
    ? receipt.result.message : 'The original Note body is not readable. Its history selection and current draft are retained.')
  if (receipt.resource.path !== expectedPath || receipt.result.document.path !== expectedPath) throw Error('The read no longer maps to the original Note file path. The current file and draft are retained.')
  const header = readNoteMarkdownHeader(receipt.result.document.content)
  if (header.status !== 'valid' || header.noteId !== noteId) throw Error('The read belongs to another or unconfirmed original Note. The current draft and history selection are retained.')
  return { target: { zoneId: params.zoneId, ...(params.spaceId === undefined ? {} : { spaceId: params.spaceId }),
    path: params.path, expectedResource: receipt.resource, noteId }, document: receipt.result.document }
}
