import { parseFileReadResult, type FileReadResult } from '@agentmux/core/files'
import type { FileDocument } from '@agentmux/core'
import { directoryIdentity, homeZoneId } from '../../../shared/space-addresses'
import { MOTE_SOUL_PATH, scratchTopicIdentityPath } from '../../../shared/scratch-topics'
import { api } from './api'
import { fileExplorerContains } from './file-explorer-scope'
import type { MoteWorkfaceScope } from './mote-workface'
import type { WorkbenchProjectionSelection } from './workbench-projection'
import { documentKey } from './workbench-tabs'
import { documentLifetime, fileInvalidationSequences } from './file-document-bookkeeping'
import { fileNavigationSelection, useAppStore } from '../store'
import { confirmedMoteReference, emptyMoteDestination, openMoteDiscussionDraft } from './mote-materials-actions'
import { replaceMoteBehaviorBlock, type MoteBehaviorPreferences } from './mote-behavior'

export type MoteCooperationSource = { path: string; observation: FileReadResult }
export type MoteCooperationDraft = { selection: WorkbenchProjectionSelection; sources: MoteCooperationSource[] }

/** A preparation observes only its selected original files, using the Editor's existing bookkeeping. */
export function captureMoteSourceRead(scope: MoteWorkfaceScope, paths: readonly string[]) {
  const before = useAppStore.getState()
  const selected = paths.map(path => {
    const key = documentKey(scope.workspace.id, path)
    return { key, document: before.documents[key], generation: before.documentGenerations[key],
      observation: before.documentObservationGenerations[key], lifetime: documentLifetime(key),
      invalidation: fileInvalidationSequences.get(key) ?? 0 }
  })
  const current = () => {
    const state = useAppStore.getState()
    return selected.every(item => {
      const document = state.documents[item.key]
      return documentLifetime(item.key) === item.lifetime &&
        (fileInvalidationSequences.get(item.key) ?? 0) === item.invalidation &&
        state.documentGenerations[item.key] === item.generation &&
        state.documentObservationGenerations[item.key] === item.observation &&
        (item.document ? document?.path === item.document.path && document.revision === item.document.revision &&
          document.content === item.document.content : !document || !state.dirtyDocuments[item.key])
    })
  }
  return {
    current,
    async verify(sources: readonly MoteCooperationSource[]) {
      // Closed files have no observer. Re-read only the bounded, selected successful sources
      // before admission, rather than treating an unrelated Workspace mutation as their change.
      const results = await Promise.all(sources.map(async ({ path, observation }) => {
        if (observation.result.status !== 'read') return true
        const latest = await readMoteMaterial(scope, path), original = observation.result.document
        return latest.result.status === 'read' && JSON.stringify(latest.resource) === JSON.stringify(observation.resource) &&
          latest.result.document.path === original.path && latest.result.document.revision === original.revision &&
          latest.result.document.content === original.content
      }))
      return current() && results.every(Boolean)
    }
  }
}

/** A real question, with only the saved SOUL and explicitly chosen original materials. */
export async function prepareMoteCooperationDraft(scope: MoteWorkfaceScope,
  reference: WorkbenchProjectionSelection | null | undefined,
  input: { question: string; materialPaths?: readonly string[] }, stillCurrent: () => boolean): Promise<MoteCooperationDraft> {
  if (!input.question.trim()) throw new Error('Write a question before preparing a discussion.')
  const paths = [...new Set([scope.rootPath + '/' + MOTE_SOUL_PATH, ...(input.materialPaths ?? [])])]
  if (paths.length > 4 || paths.some(path => !fileExplorerContains(scope.rootPath, path) || path === scope.rootPath))
    throw new Error('Choose up to three original materials in this Mote. Your question is kept.')
  const state = useAppStore.getState()
  if (!stillCurrent() || !(confirmedMoteReference(state, scope, { reference }) ?? emptyMoteDestination(state, scope, { reference })))
    throw new Error('The original Mote destination is unconfirmed. Your question and work are kept.')
  const navigation = fileNavigationSelection(state), sourceRead = captureMoteSourceRead(scope, paths)
  let changed = false
  const unsubscribe = useAppStore.subscribe(current => {
    const workspace = current.config?.workspaces.find(item => item.id === scope.workspace.id)
    if (fileNavigationSelection(current) !== navigation || !sourceRead.current() ||
        workspace?.hostId !== scope.workspace.hostId || workspace.path !== scope.workspace.path) changed = true
  })
  let sources: MoteCooperationSource[]
  try {
    sources = await Promise.all(paths.map(async path => {
      try { return { path, observation: await readMoteMaterial(scope, path) } }
      catch (error) { return { path, observation: { resource: null, result: { status: 'unknown' as const,
        code: 'MOTE_MATERIAL_READ_UNCONFIRMED', message: error instanceof Error ? error.message : String(error) } } } }
    }))
    const verified = !changed && stillCurrent() && await sourceRead.verify(sources)
    if (changed || !stillCurrent() || !verified) throw new Error('Your selection, saved materials or later question changed during the read. Your inputs and work are kept; review them and retry.')
  } finally { unsubscribe() }
  const agentMuxNote = [
    'Original Mote context: ' + JSON.stringify({ hostId: scope.workspace.hostId, workspaceId: scope.workspace.id,
      workspacePath: scope.workspace.path, moteId: scope.topic.id, directory: scope.rootPath }),
    'Saved materials read while preparing this question (not a claim that an Agent used them):\n' + sources.map(({ path, observation }) => {
      const result = observation.result
      return JSON.stringify(result.status === 'read'
        ? { path, resource: observation.resource, revision: result.document.revision,
            excerpt: result.document.content.length <= 6000 ? result.document.content : result.document.content.slice(0, 6000) + '\n[Excerpt; read the original file for the rest.]' }
        : { path, status: result.status, ...('message' in result ? { message: result.message } : {}) })
    }).join('\n'),
    'Use relevant saved facts within their recorded scope, with my current question and instructions first. Read the original files when needed; say what is unknown. This is a new discussion, not inherited unseen conversation. Saved SOUL changes apply to a new Session; an existing Session keeps its context.'
  ].join('\n\n')
  const selection = openMoteDiscussionDraft(scope, input.question, { reference, agentMuxNote })
  if (!selection) throw new Error('The exact new Launcher is unconfirmed. Your question and existing work are kept.')
  return { selection, sources }
}

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
