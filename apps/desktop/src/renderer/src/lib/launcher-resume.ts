import type { AgentSessionHistoryPage, AgentTimelineSnapshot } from '@agentmux/core'
import type { AgentSessionRecoveryCandidate, AppConfig, SessionSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { workspaceOwnsSessionPath } from '../../../shared/scratch-topics'
import { resolveAgentName } from './display-name'
import { firstPromptFromTimeline } from './workbench-tabs'
import { workspaceProjectId } from './workspace-projects'

export type LauncherRecap = { text: string; source: 'Last assistant message' | 'Last prompt'; origin: 'timeline' | 'native' }

function excerpt(text: string | undefined): string | null {
  const value = text?.replace(/\s+/gu, ' ').trim()
  return value ? (value.length > 800 ? `${value.slice(0, 799).trimEnd()}…` : value) : null
}

/** A recap is a labelled excerpt of observed conversation, never an invented summary. */
export function launcherTimelineRecap(timeline: AgentTimelineSnapshot | undefined): LauncherRecap | null {
  if (!timeline) return null
  for (const kind of ['assistant_message', 'user_message'] as const) {
    for (let index = timeline.items.length - 1; index >= 0; index -= 1) {
      const item = timeline.items[index]!
      if (item.kind !== kind) continue
      const text = excerpt(item.content)
      if (text) return { text, source: kind === 'assistant_message' ? 'Last assistant message' : 'Last prompt', origin: 'timeline' }
    }
  }
  return null
}

export function launcherNativeRecap(page: AgentSessionHistoryPage): LauncherRecap | null {
  for (const kind of ['assistant-message', 'user-message'] as const) {
    for (let index = page.items.length - 1; index >= 0; index -= 1) {
      const item = page.items[index]!
      if (item.kind !== kind) continue
      const text = excerpt(item.contentParts.flatMap(part => part.kind === 'text' ? [part.text] : []).join(' '))
      if (text) return { text, source: kind === 'assistant-message' ? 'Last assistant message' : 'Last prompt', origin: 'native' }
    }
  }
  return null
}

export type LauncherResumeRow = {
  candidate: AgentSessionRecoveryCandidate
  name: string
  workspace: WorkspaceRecord | undefined
  projectName: string
  hostName: string
  executorName: string
  recap: LauncherRecap | null
  inProject: boolean
  stateLabel: string
  stateDetail: string
}

/** Scope follows the registered Project relationship and Host; directory prefixes prove no ownership. */
export function launcherResumeRows(input: {
  candidates: readonly AgentSessionRecoveryCandidate[]
  config: AppConfig | null
  workspace?: WorkspaceRecord | undefined
  timelines: Readonly<Record<string, AgentTimelineSnapshot>>
  agentNames: Readonly<Record<string, string>>
  sessions: readonly SessionSnapshot[]
  nativeRecaps: Readonly<Record<string, LauncherRecap | null | undefined>>
}): LauncherResumeRow[] {
  const projectId = input.workspace ? workspaceProjectId(input.workspace) : null
  const sessions = new Map(input.sessions.map(session => [session.id, session]))
  return input.candidates.map(candidate => {
    const workspace = input.config?.workspaces.find(item => workspaceOwnsSessionPath(item, candidate))
    const timeline = input.timelines[candidate.agentSessionId]
    const session = sessions.get(candidate.agentSessionId)
    const continuity = session?.status.continuity
    const stateLabel = continuity === 'unavailable' ? 'Resume unavailable'
      : continuity === 'conflict' ? 'Recovery conflict'
      : session?.processState === 'running' ? 'Running'
      : session?.processState === 'exited' ? 'Exited'
      : 'Saved · Run unverified'
    return {
      candidate,
      name: resolveAgentName({
        userName: input.agentNames[candidate.agentSessionId],
        firstPrompt: firstPromptFromTimeline(timeline),
        fallback: candidate.label
      }).name,
      workspace,
      projectName: workspace?.name ?? candidate.workspacePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? candidate.workspacePath,
      hostName: input.config?.hosts.find(host => host.id === candidate.hostId)?.label ?? candidate.hostId,
      executorName: input.config?.executors[candidate.executorId]?.label ?? candidate.executorId,
      recap: launcherTimelineRecap(timeline) ?? input.nativeRecaps[candidate.agentSessionId] ?? null,
      inProject: Boolean(projectId && workspace && workspaceProjectId(workspace) === projectId),
      stateLabel,
      stateDetail: session?.status.detail ?? (session?.processState === 'running'
        ? 'The current Runtime projection reports a running Run.'
        : 'This Session is saved. Its current Run has not been confirmed; Core will check attachment or native resume when you continue.')
    }
  }).sort((left, right) => right.candidate.updatedAt - left.candidate.updatedAt || left.candidate.agentSessionId.localeCompare(right.candidate.agentSessionId))
}

export function filterLauncherResumeRows(rows: readonly LauncherResumeRow[], scope: 'project' | 'global', query: string): LauncherResumeRow[] {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean)
  return rows.filter(row => {
    if (scope === 'project' && !row.inProject) return false
    const haystack = [row.name, row.recap?.text, row.candidate.agentSessionId, row.candidate.providerId,
      row.executorName, row.candidate.executorId, row.projectName, row.candidate.workspacePath,
      row.hostName, row.candidate.hostId].join(' ').toLocaleLowerCase()
    return terms.every(term => haystack.includes(term))
  })
}

/** A displayed prefix must distinguish these candidates. Full identity stays available in the detail. */
export function launcherResumeShortId(id: string, candidates: readonly AgentSessionRecoveryCandidate[]): string {
  let length = Math.min(8, id.length)
  while (length < id.length && candidates.some(candidate => candidate.agentSessionId !== id && candidate.agentSessionId.startsWith(id.slice(0, length)))) length += 1
  return length < id.length ? `${id.slice(0, length)}…` : id
}
