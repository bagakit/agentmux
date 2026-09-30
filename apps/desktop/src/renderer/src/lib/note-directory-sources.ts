import type { AppConfig, FileDocument } from '../../../shared/contracts'
import { NOTE_FILE_EXTENSION } from '../../../shared/note-document'
import type { FileDocumentIssue } from './file-workbench-state'
import { parseNoteFile } from './note-knowledge'
import { documentKey } from './workbench-tabs'

/** Original Files directory observation. It contains references, never Note content or IDs. */
export type NoteDirectoryRead = {
  workspaceId: string
  hostId: string
  workspacePath: string
  directory: string
  fileRevision: number
  status: 'reading' | 'listed' | 'unknown'
  paths: readonly string[]
  issue?: string
}
export type NoteDirectorySourceFacts = {
  status: 'reading' | 'partial' | 'unknown' | 'complete'
  confirmedPaths: readonly string[]
  unreadPaths: readonly string[]
  unconfirmedPaths: readonly string[]
  issues: readonly string[]
}
export function noteDirectorySourceKey(workspaceId: string, filePath: string): string {
  return documentKey(workspaceId, filePath.slice(0, Math.max(0, filePath.lastIndexOf('/'))))
}

/** Completeness means this explicit directory observation, never the entire Workspace. */
export function noteDirectorySourceFacts(read: NoteDirectoryRead, state: {
  config: AppConfig | null
  documents: Readonly<Record<string, FileDocument>>
  documentIssues: Readonly<Record<string, FileDocumentIssue | undefined>>
  workspaceFileRevisions: Readonly<Record<string, number>>
}): NoteDirectorySourceFacts {
  const workspace = state.config?.workspaces.find(item => item.id === read.workspaceId)
  if (workspace?.hostId !== read.hostId || workspace.path !== read.workspacePath) return {
    status: 'unknown', confirmedPaths: [], unreadPaths: [], unconfirmedPaths: read.paths,
    issues: ['The original Note directory resource is unconfirmed. Its captured paths are retained.'] }
  const confirmed = new Set<string>(), unread: string[] = [], unconfirmed = new Set<string>(), issues: string[] = []
  const identities = new Map<string, string>()
  for (const path of read.paths) {
    const key = documentKey(read.workspaceId, path), document = state.documents[key]
    if (!document) {
      if (state.documentIssues[key]) { unconfirmed.add(path); issues.push(`${path}: File ${state.documentIssues[key]!.kind}`) }
      else unread.push(path)
      continue
    }
    const parsed = parseNoteFile(document), issue = state.documentIssues[key]
    if (!path.endsWith(NOTE_FILE_EXTENSION) || document.path !== path || parsed.status === 'invalid' || issue) {
      unconfirmed.add(path); issues.push(`${path}: ${parsed.status === 'invalid' ? parsed.message : issue ? `File ${issue.kind}` : 'The exact Note path is unconfirmed.'}`); continue
    }
    const previous = identities.get(parsed.note.noteId)
    if (previous) { confirmed.delete(previous); unconfirmed.add(previous); unconfirmed.add(path); issues.push(`The same Note identity occurs in ${previous} and ${path}. Both original sources are retained.`) }
    else { identities.set(parsed.note.noteId, path); confirmed.add(path) }
  }
  for (const [key, document] of Object.entries(state.documents)) {
    if (key === documentKey(read.workspaceId, document.path) && document.path.endsWith(NOTE_FILE_EXTENSION) &&
      noteDirectorySourceKey(read.workspaceId, document.path) === documentKey(read.workspaceId, read.directory) && !read.paths.includes(document.path)) {
      unconfirmed.add(document.path); issues.push(`${document.path}: The original Note is retained but was not confirmed by this directory listing.`)
    }
  }
  if (read.issue) issues.push(read.issue)
  const directoryChanged = read.fileRevision !== (state.workspaceFileRevisions[read.workspaceId] ?? 0)
  if (directoryChanged) issues.push('This directory changed since it was read. Refresh its Note sources to confirm the current scope.')
  return { status: read.status === 'unknown' ? 'unknown' : read.status === 'reading' ? 'reading'
    : unread.length || unconfirmed.size || directoryChanged ? 'partial' : 'complete',
    confirmedPaths: [...confirmed], unreadPaths: unread, unconfirmedPaths: [...unconfirmed], issues }
}
