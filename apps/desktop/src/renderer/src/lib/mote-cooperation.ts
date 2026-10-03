import { parseFileReadResult, type FileReadResult } from '@agentmux/core/files'
import { directoryIdentity, homeZoneId } from '../../../shared/space-addresses'
import { MOTE_SOUL_PATH, scratchTopicIdentityPath } from '../../../shared/scratch-topics'
import { api } from './api'
import { fileExplorerContains } from './file-explorer-scope'
import type { MoteWorkfaceScope } from './mote-workface'
import type { WorkbenchProjectionSelection } from './workbench-projection'
import { documentKey } from './workbench-tabs'
import { useAppStore } from '../store'

/** Only the explicitly inspected original material is read through the public typed file domain. */
export function readMoteMaterial(scope: MoteWorkfaceScope, path: string): Promise<FileReadResult> {
  if (!fileExplorerContains(scope.rootPath, path) || path === scope.rootPath) throw new Error('Choose a file in this original Mote folder.')
  const spaceId = directoryIdentity(scope.workspace.hostId, scratchTopicIdentityPath(scope.workspace, scope.topic))
  const params = { zoneId: homeZoneId(spaceId), spaceId, path: path.slice(scope.rootPath.length + 1),
    expectedResource: { hostId: scope.workspace.hostId, workspaceId: scope.workspace.id, workspacePath: scope.workspace.path } }
  return api.files.readPublic(params).then(result => parseFileReadResult(result, params))
}

export type MoteCooperationPreferences = { responses: 'concise' | 'detailed'; decisions: 'ask' | 'propose'; custom: string }
export function cooperationPreferenceText(preferences: MoteCooperationPreferences): string {
  return ['## Cooperation preferences', '', preferences.responses === 'concise' ? 'Keep replies concise; add detail when I ask.' : 'Explain the reasoning and useful details.',
    preferences.decisions === 'ask' ? 'Ask when a choice needs my judgment.' : 'Propose a concrete next step, and explain choices that need my judgment.',
    ...(preferences.custom.trim() ? [preferences.custom.trim()] : []), 'My current directions take priority over these preferences.'].join('\n')
}

/** Stage in the original Editor; its Save/conflict/unknown owner is the only writer. */
export async function stageMoteCooperationPreferences(scope: MoteWorkfaceScope, preferences: MoteCooperationPreferences,
  open: (path: string) => Promise<unknown>): Promise<void> {
  return stageMoteSoulAddition(scope, cooperationPreferenceText(preferences), open)
}

/** One original SOUL staging protocol for explicit preferences and note feedback. */
export async function stageMoteSoulAddition(scope: MoteWorkfaceScope, addition: string,
  open: (path: string) => Promise<unknown>, stillCurrent: () => boolean = () => true): Promise<void> {
  const path = scope.rootPath + '/' + MOTE_SOUL_PATH, key = documentKey(scope.workspace.id, path)
  const before = useAppStore.getState().documents[key]
  const result = await open(path) as WorkbenchProjectionSelection | null | undefined
  const state = useAppStore.getState(), workspace = state.config?.workspaces.find(item => item.id === scope.workspace.id)
  const tab = result ? state.tabs[result.tabId] : undefined, region = result ? tab?.regions[result.regionId] : undefined
  const document = state.documents[key]
  if (!stillCurrent() || workspace?.hostId !== scope.workspace.hostId || workspace.path !== scope.workspace.path || region?.kind !== 'file' ||
      region.workspaceId !== scope.workspace.id || region.path !== path || !document || state.documentIssues[key] ||
      before && (before.content !== document.content || before.revision !== document.revision)) {
    throw new Error('The original SOUL Editor or its latest content is unconfirmed. Your preferences and original draft are kept; open the file and review them there.')
  }
  state.updateDocument(tab!.id, document.content + (document.content.endsWith('\n\n') ? '' : document.content.endsWith('\n') ? '\n' : '\n\n') + addition + '\n', region.regionId)
}
