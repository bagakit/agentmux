import type { AgentSessionHistoryPage, FileDocument } from '@agentmux/core'
import type { Demand } from '@agentmux/demand'
import { MOTE_SOUL_PATH } from '../../../shared/scratch-topics'
import { api } from './api'
import type { MoteWorkfaceScope } from './mote-workface'
import { confirmedMoteReference, openMoteDiscussionDraft } from './mote-materials-actions'
import { readMoteMaterial, stageMoteSoulAddition } from './mote-cooperation'
import type { WorkbenchProjectionSelection } from './workbench-projection'
import { fileNavigationSelection, useAppStore } from '../store'

export type MoteIdeaInput = { direction: string; includeDiscussion: boolean }
export type MoteIdeaFeedback = { vote: '' | 'useful' | 'less-useful'; comment: string }
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

/** Read only on explicit preparation; latch navigation and later user input before opening a new Launcher. */
export async function prepareMoteIdeaDraft(scope: MoteWorkfaceScope, reference: WorkbenchProjectionSelection | null | undefined,
  input: MoteIdeaInput, material: FileDocument | null, stillCurrent: () => boolean): Promise<WorkbenchProjectionSelection> {
  if (!input.direction.trim()) throw new Error('Write your own direction before preparing an idea request.')
  const state = useAppStore.getState(), exact = confirmedMoteReference(state, scope, { reference })
  const tab = exact ? state.tabs[exact.tabId] : undefined, region = exact ? tab?.regions[exact.regionId] : undefined
  const session = region?.kind === 'agent' ? state.sessions.find(session => session.id === region.sessionId && session.kind === 'agent') : undefined
  const navigation = fileNavigationSelection(state)
  let changed = false
  const unsubscribe = useAppStore.subscribe(current => { if (fileNavigationSelection(current) !== navigation) changed = true })
  const sources: MoteIdeaSources = { scope, direction: input.direction, soul: null, material, discussion: null, unknown: [] }
  try {
    const reads: Promise<void>[] = [readMoteMaterial(scope, scope.rootPath + '/' + MOTE_SOUL_PATH).then(observation => {
      if (observation.result.status === 'read') sources.soul = observation.result.document
      else sources.unknown.push('Saved SOUL is unconfirmed: ' + (observation.result.status === 'unknown' || observation.result.status === 'error' ? observation.result.message : observation.result.status))
    }).catch(error => { sources.unknown.push('Saved SOUL read failed: ' + String(error)) })]
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
  const selection = openMoteDiscussionDraft(scope, moteIdeaRequestText(sources), { reference })
  if (!selection) throw new Error('The exact new Launcher is unconfirmed. Your direction and existing work are kept; inspect its original Group and retry.')
  return selection
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
