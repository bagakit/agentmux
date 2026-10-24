import { observeRead, parseNoteCorpusParams, parseNoteCorpusResult, type NoteCorpusParams, type NoteCorpusResult } from '@agentmux/core'
import type { NoteResource } from '@agentmux/core/notebook-catalog'
import { deriveNoteCorpus } from '@agentmux/client-ui/note/note-corpus'
import type { NoteFileDocument } from '@agentmux/client-ui/note/note-knowledge'
import type { WorkspaceRecord } from './content-types.js'
import type { WorkspaceFiles } from './content-types.js'
import { WORKSPACE_FILE_MAX_BYTES } from './workspace-file-bytes.js'

export type NoteCorpusSource = { resource: NoteResource; document: NoteFileDocument }
type CorpusPorts = {
  workspace(id: string): WorkspaceRecord | undefined
  files: Pick<WorkspaceFiles, 'read'> & Partial<Pick<WorkspaceFiles, 'readDirectory'>>
}
/** No writable store is borrowed here. All identity, text and revisions come from original Files. */
export async function readNoteCorpus(ports: CorpusPorts, params: NoteCorpusParams, options?: { signal?: AbortSignal }): Promise<NoteCorpusResult> {
  return (await readNoteCorpusSources(ports, params, options)).result
}
/** Same bounded file observation, with its original bytes for an in-call graph consumer. No second scan. */
export async function readNoteCorpusSources(ports: CorpusPorts, params: NoteCorpusParams, options?: { signal?: AbortSignal }): Promise<{ result: NoteCorpusResult; documents: NoteCorpusSource[] }> {
  const input = parseNoteCorpusParams(params), signal = options?.signal
  const workspace = ports.workspace(input.workspaceId)
  const maxFiles = input.maxFiles ?? 200, maxDirectories = input.maxDirectories ?? 200, maxBytes = input.maxBytes ?? 4 * 1024 * 1024
  const result: NoteCorpusResult = {
    scope: { workspaceId: input.workspaceId, path: input.path, resource: workspace ? { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path, path: input.path } : null, completeness: 'unknown', snapshot: 'per-file' },
    coverage: { directories: 0, files: 0, bytes: 0, limited: false, issues: [] },
    pages: [], duplicateNoteIds: [], references: [], search: { query: input.query ?? null, hits: [], total: 0, truncated: false }
  }
  const issue = (path: string, kind: NoteCorpusResult['coverage']['issues'][number]['kind'], message: string) => result.coverage.issues.push({ path, kind, message })
  signal?.throwIfAborted()
  if (!workspace || !ports.files.readDirectory) {
    issue(input.path, 'mapping', 'The exact original Workspace directory reader is unavailable. Its catalog, files and Agents are unchanged.')
    return { result: parseNoteCorpusResult(result, input), documents: [] }
  }
  const original = { ...workspace }, pending = [input.path], documents: NoteCorpusSource[] = []
  const current = () => { const w = ports.workspace(input.workspaceId); return w?.hostId === original.hostId && w.path === original.path }
  outer: while (pending.length) {
    signal?.throwIfAborted()
    if (!current()) { issue(input.path, 'mapping', 'The original Host or Workspace changed during this observation. Retry the same directory.'); break }
    if (result.coverage.directories >= maxDirectories) {
      result.coverage.limited = true
      issue(pending[0]!, 'budget', 'The requested directory budget was reached. Increase maxDirectories to read the remaining scope.')
      break
    }
    const directory = pending.shift()!
    result.coverage.directories++
    let entries: Awaited<ReturnType<WorkspaceFiles['readDirectory']>>
    try { entries = await observeRead(ports.files.readDirectory(original, directory), signal) }
    catch (error) { signal?.throwIfAborted(); issue(directory, 'unreadable', error instanceof Error ? error.message : String(error)); continue }
    if (!current()) { issue(directory, 'mapping', 'The original Workspace changed while listing. This directory result was not accepted.'); break }
    for (const entry of entries) {
      signal?.throwIfAborted()
      const path = directory === '.' ? entry.name : directory + '/' + entry.name
      if (entry.path !== path || !entry.name || entry.name === '.' || entry.name === '..' || /[\\/\0]/u.test(entry.name)) {
        issue(directory, 'unreadable', 'The file owner returned another directory entry.'); continue
      }
      if (entry.name === '.git') continue
      if (entry.isSymlink) { issue(path, 'symlink', 'Symbolic links are outside this exact physical file scan; their originals were not followed.'); continue }
      if (entry.isDirectory) {
        if (pending.length + result.coverage.directories < maxDirectories) pending.push(path)
        else { result.coverage.limited = true; issue(path, 'budget', 'The requested directory budget was reached. Increase maxDirectories to include this scope.') }
        continue
      }
      if (!path.endsWith('.note.md')) continue
      if (result.coverage.files >= maxFiles || result.coverage.bytes >= maxBytes) {
        result.coverage.limited = true
        issue(path, 'budget', 'The requested file or total source-byte budget was reached. Increase that explicit budget to include the remaining scope.')
        break outer
      }
      result.coverage.files++
      try {
        const read = await ports.files.read(original, path, { maxFileBytes: Math.min(WORKSPACE_FILE_MAX_BYTES, maxBytes - result.coverage.bytes), ...(signal ? { signal } : {}) })
        signal?.throwIfAborted()
        if (!current()) { issue(path, 'mapping', 'The original Workspace changed while reading. This body was not accepted.'); break outer }
        if (read.status !== 'read') { issue(path, 'unreadable', read.status === 'error' ? read.code + ': ' + read.message : 'The original source is ' + read.status + '.'); continue }
        if (read.document.path !== path) { issue(path, 'unreadable', 'The file owner returned another resource.'); continue }
        const bytes = new TextEncoder().encode(read.document.content).byteLength
        if (bytes > maxBytes - result.coverage.bytes) {
          result.coverage.limited = true
          issue(path, 'budget', 'The original file exceeded this total source-byte budget; no partial body was indexed.')
          break outer
        }
        result.coverage.bytes += bytes
        documents.push({ resource: { hostId: original.hostId, workspaceId: original.id, workspacePath: original.path, path }, document: read.document })
      } catch (error) { signal?.throwIfAborted(); issue(path, 'unreadable', error instanceof Error ? error.message : String(error)) }
    }
  }
  const complete = result.coverage.issues.length === 0 && !result.coverage.limited
  const derived = deriveNoteCorpus(documents, complete, input.query, input.limit ?? 30)
  for (const invalid of derived.invalid) issue(invalid.location.path, 'invalid', invalid.message)
  result.pages = derived.pages
  result.duplicateNoteIds = derived.duplicateNoteIds
  result.references = derived.references
  result.search = derived.search
  result.scope.completeness = result.coverage.issues.length === 0 && !result.coverage.limited && !result.duplicateNoteIds.length && result.pages.every(p => p.title !== null && p.unanchoredBlockCount === 0)
    ? 'complete' : result.pages.length ? 'partial' : 'unknown'
  return { result: parseNoteCorpusResult(result, input), documents }
}
