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
import { MOTE_BEHAVIOR_PATH, parseMoteBehaviorDocument, serializeMoteBehaviorDocument, type MoteBehaviorDraft, type MoteBehaviorPreferences } from './mote-behavior'
import { parseMoteBehaviorBlock, linkMoteBehaviorFromSoul, moteSoulForBehaviorContext } from '../../../shared/mote-behavior-legacy'

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

/** A real question, with saved SOUL/behavior and explicitly chosen original materials. */
export async function prepareMoteCooperationDraft(scope: MoteWorkfaceScope,
  reference: WorkbenchProjectionSelection | null | undefined,
  input: { question: string; materialPaths?: readonly string[] }, stillCurrent: () => boolean): Promise<MoteCooperationDraft> {
  if (!input.question.trim()) throw new Error('Write a question before preparing a discussion.')
  const paths = [...new Set([scope.rootPath + '/' + MOTE_SOUL_PATH, scope.rootPath + '/' + MOTE_BEHAVIOR_PATH, ...(input.materialPaths ?? [])])]
  if (paths.length > 5 || paths.some(path => !fileExplorerContains(scope.rootPath, path) || path === scope.rootPath))
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
  const behavior = sources.find(source => source.path === scope.rootPath + '/' + MOTE_BEHAVIOR_PATH)!
  const behaviorResult = behavior.observation.result
  const hasBehaviorAuthority = behaviorResult.status !== 'deleted'
  const parsedBehavior = behaviorResult.status === 'read' ? parseMoteBehaviorDocument(behaviorResult.document.content) : null
  const agentMuxNote = [
    'Original Mote context: ' + JSON.stringify({ hostId: scope.workspace.hostId, workspaceId: scope.workspace.id,
      workspacePath: scope.workspace.path, moteId: scope.topic.id, directory: scope.rootPath }),
    'Saved materials read while preparing this question (not a claim that an Agent used them):\n' + sources.map(({ path, observation }) => {
      const result = observation.result
      return JSON.stringify(result.status === 'read'
        ? (() => {
            const content = path === scope.rootPath + '/' + MOTE_SOUL_PATH
              ? moteSoulForBehaviorContext(result.document.content, hasBehaviorAuthority) : result.document.content
            return { path, resource: observation.resource, revision: result.document.revision,
              ...(content !== result.document.content ? { projection: 'Original SOUL with retired application behavior block omitted; the saved file is unchanged.' } : {}),
              ...(path === behavior.path && parsedBehavior ? { behaviorStatus: parsedBehavior.status,
                ...(parsedBehavior.status === 'unconfirmed' ? { message: parsedBehavior.message } : { style: parsedBehavior.code }) } : {}),
              excerpt: content.length <= 6000 ? content : content.slice(0, 6000) + '\n[Excerpt; read the original file for the rest.]' }
          })()
        : { path, status: result.status, ...('message' in result ? { message: result.message } : {}) })
    }).join('\n'),
    'Use relevant saved facts within their recorded scope, with my current question and instructions first. Read the original files when needed; say what is unknown. This is a new discussion, not inherited unseen conversation. BEHAVIOR.md is the behavior authority when present; unconfirmed settings must not be inferred from an old SOUL behavior block. Saved file changes apply to a new Session; an existing Session keeps its context.'
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
  await stageMoteFileEdit(scope, scope.rootPath + '/' + MOTE_SOUL_PATH, document => document.content + (document.content.endsWith('\n\n') ? '' : document.content.endsWith('\n') ? '\n' : '\n\n') + addition + '\n', open, stillCurrent)
}

export type SavedMoteBehavior = {
  document: FileDocument | null; legacySoul: FileDocument | null
  preferences: MoteBehaviorDraft; code: string | null; issue: string | null
}

/** Only a confirmed missing new file permits inspecting the old import source. */
export async function readMoteBehavior(scope: MoteWorkfaceScope): Promise<SavedMoteBehavior> {
  const observation = await readMoteMaterial(scope, scope.rootPath + '/' + MOTE_BEHAVIOR_PATH)
  const result = observation.result
  if (result.status === 'read') {
    const parsed = parseMoteBehaviorDocument(result.document.content)
    return { document: result.document, legacySoul: null,
      preferences: parsed.status === 'valid' ? parsed.preferences : { custom: '' },
      code: parsed.status === 'valid' ? parsed.code : null,
      issue: parsed.status === 'unconfirmed' ? parsed.message : null }
  }
  if (result.status !== 'deleted') throw new Error('Saved behavior is unconfirmed. ' + ('message' in result ? result.message : result.status))
  const soul = await readMoteMaterial(scope, scope.rootPath + '/' + MOTE_SOUL_PATH)
  if (soul.result.status !== 'read') throw new Error('The original SOUL import source is unconfirmed. ' + ('message' in soul.result ? soul.result.message : soul.result.status))
  const parsed = parseMoteBehaviorBlock(soul.result.document.content)
  return { document: null, legacySoul: soul.result.document,
    preferences: parsed.status === 'valid' ? parsed.preferences : { custom: '' },
    code: parsed.status === 'valid' ? parsed.code : null,
    issue: parsed.status === 'unconfirmed' ? parsed.message : null }
}

/** Upgrade and Save use the original Editor's document, conflict and unknown protocol. */
export async function saveMoteBehaviorPreferences(scope: MoteWorkfaceScope, preferences: MoteBehaviorPreferences,
  saved: SavedMoteBehavior, open: (path: string) => Promise<unknown>, stillCurrent: () => boolean,
  reference?: WorkbenchProjectionSelection | null): Promise<void> {
  const initial = useAppStore.getState()
  const exact = confirmedMoteReference(initial, scope, { reference }) ?? emptyMoteDestination(initial, scope, { reference })
  if (!exact) throw new Error('The original Mote display is unconfirmed. Your form is kept; select its exact Tab and Region, or its exact empty Group, and retry.')
  const navigation = fileNavigationSelection(initial)
  let changed = false
  const unsubscribe = useAppStore.subscribe(current => { if (fileNavigationSelection(current) !== navigation) changed = true })
  let source: SavedMoteBehavior, soul: FileDocument
  try {
    source = await readMoteBehavior(scope)
    const read = await readMoteMaterial(scope, scope.rootPath + '/' + MOTE_SOUL_PATH)
    if (read.result.status !== 'read') throw new Error('The original SOUL is unconfirmed. Inspect it before saving the reference.')
    soul = read.result.document
    const original = saved.document ?? saved.legacySoul, current = source.document ?? source.legacySoul
    if (changed || !stillCurrent() || source.issue || !original || !current ||
        original.path !== current.path || original.revision !== current.revision || original.content !== current.content)
      throw new Error(source.issue ?? 'The saved behavior, selection or later input changed or is unconfirmed. Your form and original draft are kept; reread settings before saving.')
  } finally { unsubscribe() }
  const legacy = parseMoteBehaviorBlock(soul.content)
  if (legacy.status === 'unconfirmed') throw new Error(legacy.message)
  const path = scope.rootPath + '/' + MOTE_BEHAVIOR_PATH
  let behavior = source.document
  // Import the original choices before changing them. A partial import can resume without blind writes.
  if (!behavior) {
    if (!stillCurrent()) throw new Error('Your later input is kept. Retry saving when ready.')
    const resource = useAppStore.getState().config?.workspaces.find(item => item.id === scope.workspace.id)
    if (resource?.hostId !== scope.workspace.hostId || resource.path !== scope.workspace.path) throw new Error('The original Mote resource changed. Your form is kept; return to its original folder before saving.')
    await useAppStore.getState().createPath({ path, kind: 'file' }, scope.workspace.id)
    const created = await readMoteMaterial(scope, path)
    if (created.result.status !== 'read' || created.result.document.content !== '')
      throw new Error('Behavior file creation is unconfirmed. Your choices are kept; inspect the original file before retrying.')
    behavior = await saveMoteFile(scope, path, created.result.document,
      serializeMoteBehaviorDocument('', source.preferences), open, stillCurrent, exact)
  } else if (legacy.status === 'valid' && (source.code !== legacy.code || source.preferences.custom !== legacy.preferences.custom)) {
    throw new Error('BEHAVIOR.md and the old SOUL behavior block differ. Both originals are kept; review their contents before completing the import.')
  }
  const linked = linkMoteBehaviorFromSoul(soul.content)
  if (linked !== soul.content) {
    try { await saveMoteFile(scope, scope.rootPath + '/' + MOTE_SOUL_PATH, soul, linked, open, stillCurrent, exact) }
    catch (cause) { throw new Error('The imported behavior file is kept, but the SOUL reference is unconfirmed. Reread settings to continue this import. ' + (cause instanceof Error ? cause.message : String(cause))) }
  }
  await saveMoteFile(scope, path, behavior, serializeMoteBehaviorDocument(behavior.content, preferences), open, stillCurrent, exact)
}

async function saveMoteFile(scope: MoteWorkfaceScope, path: string, saved: FileDocument, next: string,
  open: (path: string) => Promise<unknown>, stillCurrent: () => boolean,
  exact: Pick<WorkbenchProjectionSelection, 'displayWorkspaceId' | 'groupId'>): Promise<FileDocument> {
  const key = documentKey(scope.workspace.id, path), before = useAppStore.getState()
  if (before.dirtyDocuments[key] || before.documentIssues[key]) throw new Error('The original Editor has an unsaved or unconfirmed draft. It is kept; review that file before saving settings.')
  const selected = await stageMoteFileEdit(scope, path, document => {
    if (document.revision !== saved.revision || document.content !== saved.content)
      throw new Error('The original Editor revision changed. Your form and original draft are kept; reread the file.')
    return next
  }, open, stillCurrent, exact)
  await useAppStore.getState().saveDocument(selected.tabId, selected.regionId)
  const state = useAppStore.getState(), document = state.documents[key]
  const region = state.tabs[selected.tabId]?.regions[selected.regionId]
  const resource = state.config?.workspaces.find(item => item.id === scope.workspace.id)
  if (!stillCurrent() || resource?.hostId !== scope.workspace.hostId || resource.path !== scope.workspace.path ||
      region?.kind !== 'file' || region.path !== path || region.workspaceId !== scope.workspace.id || !document ||
      document.content !== next || state.dirtyDocuments[key] || state.documentIssues[key] || state.savingDocuments[key])
    throw new Error('Saving is unconfirmed. Your choices and original Editor draft are kept; inspect its save status before retrying.')
  const read = await readMoteMaterial(scope, path)
  if (!stillCurrent() || read.result.status !== 'read' || read.result.document.content !== next ||
      read.result.document.revision !== document.revision || useAppStore.getState().documents[key] !== document ||
      useAppStore.getState().documentIssues[key]) throw new Error('The saved file could not be confirmed. Your choices are kept; inspect the original file and read it again before retrying.')
  return read.result.document
}

/** Original Editor remains the sole Save/conflict/unknown writer. */
async function stageMoteFileEdit(scope: MoteWorkfaceScope, path: string, transform: (document: FileDocument) => string,
  open: (path: string) => Promise<unknown>, stillCurrent: () => boolean,
  exact?: Pick<WorkbenchProjectionSelection, 'displayWorkspaceId' | 'groupId'>): Promise<WorkbenchProjectionSelection> {
  const key = documentKey(scope.workspace.id, path)
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
  return result!
}
