import { scratchWorkspaceFilePath } from '@agentmux/host/mote-model'
import type { FileDocument } from '../../../shared/contracts'
import { sourceFileNativeHost } from '../../../shared/source-files'
import type { AppState } from '../store'
import { api } from './api'
import { sourceFilePhysicalPath } from './source-file-native-path'
import { scratchTopicsForWorkspace } from './scratch-topic-snapshots'
import { documentKey, fileViewPointerKey, type FileWorkbenchSurface } from './workbench-tabs'

type ReadSource = FileDocument['readSource']
type ViewState = Pick<AppState, 'documents' | 'sourceFilesInputs' | 'config' | 'scratchTopicSnapshots' | 'reportError'>

export function fileViewReadSource(state: ViewState, tabId: string, view: FileWorkbenchSurface): ReadSource {
  const source = state.documents[documentKey(view.workspaceId, view.path)]?.readSource
  if (source) return source
  const pointer = state.sourceFilesInputs.readSources?.[fileViewPointerKey(tabId, view.regionId)]
  return pointer?.workspaceId === view.workspaceId && pointer.path === view.path ? pointer.source : undefined
}

export function fileViewHost(source: ReadSource, workspaceHost: string | undefined) {
  return source ? sourceFileNativeHost(source) : workspaceHost
}

/** Resolve only when the user copies. Relative addresses can still be copied while the physical mapping is unknown. */
export function fileViewAbsolutePath(state: ViewState, view: FileWorkbenchSurface, source: ReadSource): string | null {
  const workspace = state.config?.workspaces.find(item => item.id === (source?.resource.workspaceId ?? view.workspaceId))
  const topics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, workspace)
  const path = source ? sourceFilePhysicalPath(source, workspace, topics) : workspace ? scratchWorkspaceFilePath(workspace, topics, view.path) : null
  if (!path) state.reportError(new Error('The physical path of this original file is unconfirmed. Refresh its Files view and try again.'))
  return path
}

export async function revealFileInFileManager(workspaceId: string, path: string, reportError: (error: unknown) => void, source?: ReadSource) {
  try {
    if (source) await api.files.reveal(workspaceId, path, source)
    else await api.files.reveal(workspaceId, path)
  } catch (error) { reportError(error) }
}
