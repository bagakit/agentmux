import { parseFileReadResult, type FileReadResult } from '@agentmux/core/files'
import type { FileDocument } from '@agentmux/core'
import { directoryIdentity, homeZoneId } from '../../../shared/space-addresses'
import { MOTE_SOUL_PATH, scratchTopicIdentityPath } from '../../../shared/scratch-topics'
import { api } from './api'
import { fileExplorerContains } from './file-explorer-scope'
import type { MoteWorkfaceScope } from './mote-workface'
import type { WorkbenchProjectionSelection } from './workbench-projection'
import { documentKey } from './workbench-tabs'
import { fileNavigationSelection, useAppStore } from '../store'
import { confirmedMoteReference, emptyMoteDestination } from './mote-materials-actions'
import { replaceMoteBehaviorBlock, type MoteBehaviorPreferences } from './mote-behavior'

/** Only the explicitly inspected original material is read through the public typed file domain. */
export function readMoteMaterial(scope: MoteWorkfaceScope, path: string): Promise<FileReadResult> {
  if (!fileExplorerContains(scope.rootPath, path) || path === scope.rootPath) throw new Error('Choose a file in this original Mote folder.')
  const spaceId = directoryIdentity(scope.workspace.hostId, scratchTopicIdentityPath(scope.workspace, scope.topic))
  const params = { zoneId: homeZoneId(spaceId), spaceId, path: path.slice(scope.rootPath.length + 1),
    expectedResource: { hostId: scope.workspace.hostId, workspaceId: scope.workspace.id, workspacePath: scope.workspace.path } }
  return api.files.readPublic(params).then(result => parseFileReadResult(result, params))
}

/** One original SOUL staging protocol for explicit preferences and note feedback. */
export async function stageMoteSoulAddition(scope: MoteWorkfaceScope, addition: string,
  open: (path: string) => Promise<unknown>, stillCurrent: () => boolean = () => true): Promise<void> {
  return stageMoteSoulEdit(scope, document => document.content + (document.content.endsWith('\n\n') ? '' : document.content.endsWith('\n') ? '\n' : '\n\n') + addition + '\n', open, stillCurrent)
}

/** Latest saved source, original draft and exact presentation must agree before a reviewed replacement. */
export async function stageMoteBehaviorPreferences(scope: MoteWorkfaceScope, preferences: MoteBehaviorPreferences,
  saved: FileDocument, open: (path: string) => Promise<unknown>, stillCurrent: () => boolean,
  reference?: WorkbenchProjectionSelection | null): Promise<void> {
  const state = useAppStore.getState(), exact = confirmedMoteReference(state, scope, { reference }) ?? emptyMoteDestination(state, scope, { reference })
  if (!exact) throw new Error('The original Mote display is unconfirmed. Your form is kept; select its exact Tab and Region, or its exact empty Group, and retry.')
  const navigation = fileNavigationSelection(state), key = documentKey(scope.workspace.id, scope.rootPath + '/' + MOTE_SOUL_PATH), before = state.documents[key]
  let changed = false
  const unsubscribe = useAppStore.subscribe(current => {
    const workspace = current.config?.workspaces.find(item => item.id === scope.workspace.id)
    if (fileNavigationSelection(current) !== navigation || workspace?.hostId !== scope.workspace.hostId || workspace.path !== scope.workspace.path) changed = true
  })
  try {
    const observation = await readMoteMaterial(scope, scope.rootPath + '/' + MOTE_SOUL_PATH)
    const current = useAppStore.getState().documents[key], result = observation.result
    if (changed || !stillCurrent() || result.status !== 'read' || saved.path !== result.document.path ||
      saved.revision !== result.document.revision || saved.content !== result.document.content ||
      before && (current?.content !== before.content || current.revision !== before.revision))
      throw new Error('The saved SOUL, selection or later input changed or is unconfirmed. Your form and original draft are kept; reread the file before reviewing changes.')
  } finally { unsubscribe() }
  return stageMoteSoulEdit(scope, document => {
    if (document.revision !== saved.revision) throw new Error('The original Editor revision changed. Your form and original draft are kept; review the latest file.')
    return replaceMoteBehaviorBlock(document.content, preferences)
  }, open, stillCurrent, exact)
}

/** Original Editor remains the sole Save/conflict/unknown writer. */
async function stageMoteSoulEdit(scope: MoteWorkfaceScope, transform: (document: FileDocument) => string,
  open: (path: string) => Promise<unknown>, stillCurrent: () => boolean,
  exact?: Pick<WorkbenchProjectionSelection, 'displayWorkspaceId' | 'groupId'>): Promise<void> {
  const path = scope.rootPath + '/' + MOTE_SOUL_PATH, key = documentKey(scope.workspace.id, path)
  const before = useAppStore.getState().documents[key]
  const result = await open(path) as WorkbenchProjectionSelection | null | undefined
  const state = useAppStore.getState(), workspace = state.config?.workspaces.find(item => item.id === scope.workspace.id)
  const tab = result ? state.tabs[result.tabId] : undefined, region = result ? tab?.regions[result.regionId] : undefined
  const document = state.documents[key]
  if (!stillCurrent() || workspace?.hostId !== scope.workspace.hostId || workspace.path !== scope.workspace.path || region?.kind !== 'file' ||
      region.workspaceId !== scope.workspace.id || region.path !== path || !document || state.documentIssues[key] ||
      exact && (result?.displayWorkspaceId !== exact.displayWorkspaceId || result.groupId !== exact.groupId) ||
      before && (before.content !== document.content || before.revision !== document.revision)) {
    throw new Error('The original SOUL Editor or its latest content is unconfirmed. Your preferences and original draft are kept; open the file and review them there.')
  }
  state.updateDocument(tab!.id, transform(document), region.regionId)
}
