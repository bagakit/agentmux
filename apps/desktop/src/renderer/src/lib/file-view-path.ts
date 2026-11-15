import { scratchWorkspaceFilePath } from '@agentmux/host/mote-model'
import type { FileDocument } from '../../../shared/contracts'
import { sourceFileNativeHost, type FileActionLocation } from '../../../shared/source-files'
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

export function fileViewHost(location: FileActionLocation, workspaceHost: string | undefined) {
  return location.kind === 'source' ? sourceFileNativeHost(location.source) : workspaceHost
}

/** Resolve only when the user copies. Relative addresses can still be copied while the physical mapping is unknown. */
export function fileViewAbsolutePath(state: ViewState, location: FileActionLocation): string | null {
  const workspaceId = location.kind === 'source' ? location.source.resource.workspaceId : location.workspaceId
  const workspace = state.config?.workspaces.find(item => item.id === workspaceId)
  const topics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, workspace)
  const path = location.kind === 'source' ? sourceFilePhysicalPath(location.source, workspace, topics)
    : workspace ? scratchWorkspaceFilePath(workspace, topics, location.path) : null
  if (!path) state.reportError(new Error('The physical path of this original file is unconfirmed. Refresh its Files view and try again.'))
  return path
}

export function revealFileInFileManager(location: FileActionLocation, reportError: (error: unknown) => void) {
  return api.files.reveal(location).catch(reportError)
}
