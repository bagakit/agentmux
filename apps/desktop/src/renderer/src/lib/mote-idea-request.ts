import type { AgentSessionHistoryPage, ContinuousProgressTarget, FileDocument } from '@agentmux/core'
import type { Demand } from '@agentmux/demand'
import { MOTE_SOUL_PATH } from '../../../shared/scratch-topics'
import { api } from './api'
import type { MoteWorkfaceScope } from './mote-workface'
import { confirmedMoteReference, emptyMoteDestination, openMoteDiscussionDraft } from './mote-materials-actions'
import { readMoteMaterial, stageMoteSoulAddition, type MoteCooperationSource } from './mote-cooperation'
import { fileExplorerContains } from './file-explorer-scope'
import type { WorkbenchProjectionSelection } from './workbench-projection'
import { fileNavigationSelection, useAppStore } from '../store'

export type MoteIdeaInput = { direction: string; includeDiscussion: boolean }
export type MoteIdeaFeedback = { vote: '' | 'useful' | 'less-useful'; comment: string }
export type MoteIdeaSchedulePreparation = {
  target: ContinuousProgressTarget; message: string; frozenContext: string; sources: readonly MoteCooperationSource[]
}
export type MoteIdeaSources = {
  scope: MoteWorkfaceScope; direction: string; soul: FileDocument | null; material: FileDocument | null
  discussion: { rendererSessionId: string; hostId: string; agentSessionId: string; page: AgentSessionHistoryPage | null; goals: Demand[] } | null
  unknown: string[]
}
const excerpt = (text: string, limit = 6000) => text.length <= limit ? text : text.slice(0, limit) + '\n[Excerpt; the rest remains in the original source.]'
const sourceDocument = (document: FileDocument) => JSON.stringify({ path: document.path, revision: document.revision, excerpt: excerpt(document.content) })

/** A request to a real Agent, never an authored suggestion or completed result. */
export function moteIdeaRequestText(sources: MoteIdeaSources): string {
  const { scope, discussion } = sources
  return [
    'Help me find up to three worthwhile ideas for the direction below. Explain why each relates to my current work, cite the actual source and its scope, and give one concrete next step and a discussion starter. Distinguish evidence from suggestions and say what remains unknown.',
    'Read relevant original sources when needed. Keep my current directions and explicit preferences first. This request permits discussion and read-only research; sending messages, purchasing, scheduling or external writes need separate authorization. Do not claim an idea was generated, saved or completed before that actually happens.',
    'User direction:\n' + sources.direction.trim(),
    'Original Mote resource: ' + JSON.stringify({ hostId: scope.workspace.hostId, workspaceId: scope.workspace.id, workspacePath: scope.workspace.path, moteId: scope.topic.id, directory: scope.rootPath }),
    'Saved SOUL: ' + (sources.soul ? sourceDocument(sources.soul) : 'unconfirmed; do not invent saved preferences.'),
    'Explicitly selected saved material: ' + (sources.material ? sourceDocument(sources.material) : 'none confirmed for this request.'),
    ...(discussion ? [
      'Explicit discussion source: ' + JSON.stringify({ rendererSessionId: discussion.rendererSessionId, hostId: discussion.hostId, agentSessionId: discussion.agentSessionId, nativeSource: discussion.page?.source ?? null }),
      'Newest returned conversation entries (up to 8; text excerpts): ' + JSON.stringify((discussion.page?.items ?? []).filter(item => item.kind !== 'activity').slice(-8).map(item => ({ id: item.id, kind: item.kind, text: excerpt(item.contentParts.filter(part => part.kind === 'text').map(part => part.text).join('\n'), 1000) }))),
      'Original linked Goals (Renderer Session association, up to 3): ' + JSON.stringify(discussion.goals.map(goal => ({ id: goal.id, title: goal.title, description: excerpt(goal.description, 1000), status: goal.status, updatedAt: goal.updatedAt })))
    ] : ['Discussion history and linked Goals: not included.']),
    'Unknown or omitted context: ' + (sources.unknown.length ? sources.unknown.join(' ') : 'No additional observation failure in these reads. Source statements still require judgment.'),
    'If I choose an idea, help continue it in the original discussion and save its reason, source and next step in an original note when I ask. Preserve unrelated notes and conversation.'
  ].join('\n\n')
}

/** One read-only source preparation for both manual questions and explicit calendar opt-in. */
async function readMoteIdeaSources(scope: MoteWorkfaceScope, reference: WorkbenchProjectionSelection | null | undefined,
  input: MoteIdeaInput, material: FileDocument | null, stillCurrent: () => boolean, requireTarget: boolean) {
  if (!input.direction.trim()) throw new Error('Write your own direction before preparing an idea request.')
  if (material && (!fileExplorerContains(scope.rootPath, material.path) || material.path === scope.rootPath))
    throw new Error('Choose an original saved material in this Mote. Your direction is kept.')
  const state = useAppStore.getState(), exact = confirmedMoteReference(state, scope, { reference })
  const empty = !exact && !requireTarget ? emptyMoteDestination(state, scope, { reference }) : null
  if (!stillCurrent() || !exact && !empty) throw new Error('The exact original Mote discussion is unconfirmed. Your direction and existing work are kept.')
  const tab = exact ? state.tabs[exact.tabId] : undefined, region = exact ? tab?.regions[exact.regionId] : undefined
  const session = region?.kind === 'agent' ? state.sessions.find(session => session.id === region.sessionId && session.kind === 'agent') : undefined
  const target = session?.kind === 'agent' ? { hostId: session.control.hostId, agentSessionId: session.control.agentSessionId,
    providerId: session.providerId, workspacePath: session.workspacePath } : null
  if (requireTarget && (!target || Object.values(target).some(value => !value.trim())))
    throw new Error('Choose the exact Agent discussion for this arrangement. Manual idea questions remain available.')
  const navigation = fileNavigationSelection(state), revision = state.workspaceFileRevisions[scope.workspace.id]
  let changed = false
  const unsubscribe = useAppStore.subscribe(current => {
    const workspace = current.config?.workspaces.find(item => item.id === scope.workspace.id)
    const currentRegion = exact ? current.tabs[exact.tabId]?.regions[exact.regionId] : undefined
    const currentSession = currentRegion?.kind === 'agent' ? current.sessions.find(item => item.id === currentRegion.sessionId && item.kind === 'agent') : undefined
    if (fileNavigationSelection(current) !== navigation || current.workspaceFileRevisions[scope.workspace.id] !== revision ||
        workspace?.hostId !== scope.workspace.hostId || workspace.path !== scope.workspace.path ||
        (exact ? !confirmedMoteReference(current, scope, { reference: exact }) : !emptyMoteDestination(current, scope, { reference })) ||
        (session?.kind === 'agent' && (currentSession?.kind !== 'agent' || currentSession.id !== session.id ||
          currentSession.control.hostId !== session.control.hostId || currentSession.control.agentSessionId !== session.control.agentSessionId ||
          currentSession.providerId !== session.providerId || currentSession.workspacePath !== session.workspacePath ||
          input.includeDiscussion && currentSession.nativeSessionId !== session.nativeSessionId))) changed = true
  })
  const sources: MoteIdeaSources = { scope, direction: input.direction, soul: null, material: null, discussion: null, unknown: [] }
  const observations: MoteCooperationSource[] = []
  try {
    const paths = [...new Set([scope.rootPath + '/' + MOTE_SOUL_PATH, ...(material ? [material.path] : [])])]
    const reads: Promise<void>[] = paths.map(async path => {
      let observation: MoteCooperationSource['observation']
      try { observation = await readMoteMaterial(scope, path) }
      catch (error) { observation = { resource: null, result: { status: 'unknown', code: 'MOTE_IDEA_SOURCE_UNCONFIRMED', message: String(error) } } }
      observations[paths.indexOf(path)] = { path, observation }
      if (observation.result.status === 'read') {
        if (path === scope.rootPath + '/' + MOTE_SOUL_PATH) sources.soul = observation.result.document
        if (path === material?.path) sources.material = observation.result.document
      } else sources.unknown.push('Saved source ' + path + ' is unconfirmed: ' +
        (observation.result.status === 'unknown' || observation.result.status === 'error' ? observation.result.message : observation.result.status))
    })
    if (input.includeDiscussion && session?.kind === 'agent') {
      const control = { hostId: session.control.hostId, agentSessionId: session.control.agentSessionId }
      const discussion = { rendererSessionId: session.id, ...control, page: null as AgentSessionHistoryPage | null, goals: [] as Demand[] }
      sources.discussion = discussion
      reads.push(api.sessions.historyPage(control, { limit: 8 }).then(page => {
        if (page.agentSessionId !== control.agentSessionId || page.source.providerId !== session.providerId || session.nativeSessionId && page.source.nativeSessionId !== session.nativeSessionId) throw new Error('The original history source changed; no replacement conversation was included.')
        discussion.page = page
      }).catch(error => { sources.unknown.push('Original discussion history is unconfirmed: ' + String(error)) }),
      api.demands.list().then(goals => { discussion.goals = goals.filter(goal => goal.sessionIds.includes(session.id)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3) })
        .catch(error => { sources.unknown.push('Original linked Goals are unconfirmed: ' + String(error)) }))
    } else if (input.includeDiscussion) sources.unknown.push('No exact Agent Region is confirmed; discussion history and linked Goals were omitted.')
    await Promise.all(reads)
    if (changed || !stillCurrent()) throw new Error('The original selection or your later input changed during the read. Your inputs and existing work are kept; review them and retry.')
  } finally { unsubscribe() }
  return { sources, observations, target, reference: exact }
}

/** The visible question stays user-authored; technical context travels in the original launch note. */
export async function prepareMoteIdeaDraft(scope: MoteWorkfaceScope, reference: WorkbenchProjectionSelection | null | undefined,
  input: MoteIdeaInput, material: FileDocument | null, stillCurrent: () => boolean): Promise<WorkbenchProjectionSelection> {
  const prepared = await readMoteIdeaSources(scope, reference, input, material, stillCurrent, false)
  const selection = openMoteDiscussionDraft(scope, input.direction, { reference: prepared.reference, agentMuxNote: moteIdeaRequestText(prepared.sources) })
  if (!selection) throw new Error('The exact new Launcher is unconfirmed. Your direction and existing work are kept; inspect its original Group and retry.')
  return selection
}

/** Prepares an editable intent, never a saved arrangement, generated idea or started Agent. */
export async function prepareMoteIdeaSchedule(scope: MoteWorkfaceScope, reference: WorkbenchProjectionSelection | null | undefined,
  input: MoteIdeaInput, material: FileDocument | null, stillCurrent: () => boolean): Promise<MoteIdeaSchedulePreparation> {
  const prepared = await readMoteIdeaSources(scope, reference, input, material, stillCurrent, true)
  if (!prepared.target) throw new Error('The original arrangement target is unconfirmed. Your direction is kept.')
  const context = [
    'For this direction, propose up to three useful ideas. Explain the reason, cite the original source and give one concrete next step. Facts and suggestions must be distinct; a proposal is not accepted work or a completed result.',
    'Original Mote: ' + scope.topic.id + '\nSource Host: ' + scope.workspace.hostId + '\nSource Workspace: ' + scope.workspace.id + '\nSource Workspace path: ' + scope.workspace.path + '\nOriginal Mote folder: ' + scope.rootPath,
    'Source observations made while preparing this arrangement (not a claim that an Agent used them):',
    ...prepared.observations.map(({ path, observation }) => {
      const resource = observation.resource, result = observation.result
      return ['Original file: ' + path, ...(resource ? ['Host: ' + resource.hostId, 'Workspace: ' + resource.workspaceId,
        'Workspace path: ' + resource.workspacePath, 'Zone: ' + resource.zoneId, 'Zone path: ' + resource.zonePath,
        'File path in this Workspace: ' + resource.path, 'File path in this Zone: ' + path.slice(scope.rootPath.length + 1)] : ['Original resource is unconfirmed; do not guess another file.']),
        result.status === 'read' || result.status === 'binary' ? 'Revision observed at preparation: ' + (result.status === 'read' ? result.document.revision : result.revision)
          : 'Observed status: ' + result.status + ('message' in result ? ' — ' + result.message : '')].join('\n')
    }),
    ...(prepared.sources.discussion ? [
      'Explicit discussion source: Renderer Session ' + prepared.sources.discussion.rendererSessionId + '; Host ' + prepared.sources.discussion.hostId + '; Core AgentSession ' + prepared.sources.discussion.agentSessionId,
      'Conversation observations at preparation:\n' + (prepared.sources.discussion.page?.items ?? []).filter(item => item.kind !== 'activity').slice(-8)
        .map(item => item.id + ' (' + item.kind + '): ' + excerpt(item.contentParts.filter(part => part.kind === 'text').map(part => part.text).join('\n'), 1000)).join('\n'),
      'Original linked Goals observed at preparation:\n' + prepared.sources.discussion.goals.map(goal => goal.id + ': ' + goal.title + ' — ' + goal.status + '\n' + excerpt(goal.description, 1000)).join('\n')
    ] : ['Discussion history and linked Goals are not included.']),
    'For each delivered request, read the current relevant original files using the original file.read / file.ls capability. These revisions and conversation/Goal observations are last-confirmed preparation facts, not current truth or a required future revision. Report failed or unknown reads; do not substitute a neighboring Mote, unseen conversation or invented source.',
    ...(prepared.sources.unknown.length ? ['Unconfirmed observations: ' + prepared.sources.unknown.join(' ')] : []),
    'Current human instructions take priority. Saved SOUL changes apply to a new Session; do not claim an existing Session was hot-updated. Continue a chosen idea through the original discussion/Goal and save an original note only when asked; preserve unrelated work and explicit feedback.'
  ].join('\n\n')
  return { target: prepared.target, message: input.direction, frozenContext: context, sources: prepared.observations }
}

export function moteIdeaFeedbackText(material: FileDocument, feedback: MoteIdeaFeedback): string {
  if (!feedback.vote && !feedback.comment.trim()) throw new Error('Choose useful or less useful, or write your feedback first.')
  return ['## Idea feedback', '', 'Original note: ' + material.path, 'Saved file revision: ' + material.revision,
    'My response: ' + (feedback.vote === 'useful' ? 'Useful' : feedback.vote === 'less-useful' ? 'Less useful' : 'Comment'),
    ...(feedback.comment.trim() ? [feedback.comment.trim()] : []), 'Use this feedback for later suggestions in this Mote. My current directions take priority.'].join('\n')
}
export async function stageMoteIdeaFeedback(scope: MoteWorkfaceScope, material: FileDocument, feedback: MoteIdeaFeedback,
  open: (path: string) => Promise<unknown>, stillCurrent: () => boolean): Promise<void> {
  return stageMoteSoulAddition(scope, moteIdeaFeedbackText(material, feedback), open, stillCurrent)
}
