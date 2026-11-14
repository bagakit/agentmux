import type { FileDirectoryListing, FileNameListing } from '@agentmux/core/files'
import type { AppState } from '../store'
import { api } from './api'
import { sourceFilesMappingMatches, sourceFilesQuery, sourceFilesWorkspaceMatches } from './source-files-workbench'

type State = Pick<AppState, 'config' | 'sourceFilesInputs' | 'documents'>
const sourceUnavailable = () => new Error('The original Source directory is unconfirmed. Its files, editors and requests are kept; check that Source folder before discovering candidates.')
/** Called only for an explicit directory/name observation, never on document input. */
function hasOriginalSource(state: State, workspaceId: string): boolean {
  return Boolean(state.sourceFilesInputs.selections[workspaceId] ||
    Object.values(state.sourceFilesInputs.readSources ?? {}).some(pointer => pointer.workspaceId === workspaceId) ||
    Object.entries(state.documents).some(([key, document]) => key.startsWith(workspaceId + '\0') && document.readSource))
}
async function sourceListing(workspaceId: string, path: string, mode: 'directory' | undefined, get: () => State) {
  const before = get(), input = before.sourceFilesInputs.selections[workspaceId]
  if (!input) { if (hasOriginalSource(before, workspaceId)) throw sourceUnavailable(); return null }
  if (!input.locator || !sourceFilesWorkspaceMatches(input.workspace, before.config?.workspaces.find(workspace => workspace.id === workspaceId))) throw sourceUnavailable()
  const reply = await api.sourceFiles.call(input.target, 'file.list', { ...sourceFilesQuery(input.locator, path), ...(mode ? { mode } : {}) })
  const after = get()
  if (after.sourceFilesInputs.selections[workspaceId] !== input ||
      !sourceFilesWorkspaceMatches(input.workspace, after.config?.workspaces.find(workspace => workspace.id === workspaceId)) ||
      !reply.carrierCurrent || !reply.result.resource || !sourceFilesMappingMatches(input.locator, reply.result.resource, path)) throw sourceUnavailable()
  if (reply.result.result.status === 'unknown') throw new Error(reply.result.result.message)
  return reply.result.result
}
export async function listWorkspaceFileNames(workspaceId: string, get: () => State): Promise<FileNameListing> {
  const result = await sourceListing(workspaceId, '', undefined, get)
  if (result) { if (result.status !== 'listed') throw sourceUnavailable(); return result }
  const legacy = await api.files.list(workspaceId)
  if (hasOriginalSource(get(), workspaceId)) throw sourceUnavailable()
  return legacy
}
export async function readWorkspaceDirectory(workspaceId: string, path: string, get: () => State): Promise<Pick<FileDirectoryListing, 'entries' | 'complete'>> {
  const result = await sourceListing(workspaceId, path, 'directory', get)
  if (result) {
    if (result.status !== 'directory-listed') throw sourceUnavailable()
    // Public children are Source Workspace-relative; this projection uses the exact
    // original queried display directory, never a guessed Host/Zone/root mapping.
    return { ...result, entries: result.entries.map(entry => ({ ...entry, path: path ? path + '/' + entry.name : entry.name })) }
  }
  const entries = await api.files.readDirectory(workspaceId, path)
  if (hasOriginalSource(get(), workspaceId)) throw sourceUnavailable()
  return { entries, complete: true }
}
