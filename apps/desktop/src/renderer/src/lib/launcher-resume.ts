import type { AgentNativeSessionCandidate, AgentSessionHistoryPage, AgentTimelineSnapshot } from '@agentmux/core'
import { parseAgentMuxMessagePrefix } from '@agentmux/core/agent-message-render'
import { clampStep } from '@agentmux/client-ui/activity-step-summary'
import type { AgentSessionRecoveryCandidate, AppConfig, SessionSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { workspaceOwnsSessionPath } from '../../../shared/scratch-topics'
import { resolveAgentName } from './display-name'
import { firstPromptFromTimeline } from './workbench-tabs'
import { workspaceProjectId } from './workspace-projects'

export type LauncherRecap = { text: string; displayText?: string; reading?: { text: string; truncated: boolean }; source: 'Last assistant message' | 'Last prompt'; origin: 'timeline' | 'native' }

function excerpt(text: string | undefined): Pick<LauncherRecap, 'text' | 'displayText' | 'reading'> | null {
  const value = text?.replace(/\s+/gu, ' ').trim()
  if (!value) return null
  const clamp = (body: string) => body.length > 800 ? `${body.slice(0, 799).trimEnd()}…` : body
  // Interpret complete reading wrappers before flattening; declarations prove no author.
  const parsedBody = parseAgentMuxMessagePrefix(text!)?.body.trim()
  const reading = parsedBody || text!.trim()
  const body = reading.replace(/\s+/gu, ' ').trim()
  return { text: clamp(value), ...(body && body !== value ? { displayText: clamp(body) } : {}),
    reading: { text: clampStep(reading.slice(0, 1000), 'head', 800), truncated: reading.length > 800 } }
}

/** A recap is a labelled excerpt of observed conversation, never an invented summary. */
export function launcherTimelineRecap(timeline: AgentTimelineSnapshot | undefined): LauncherRecap | null {
  if (!timeline) return null
  for (const kind of ['assistant_message', 'user_message'] as const) {
    for (let index = timeline.items.length - 1; index >= 0; index -= 1) {
      const item = timeline.items[index]!
      if (item.kind !== kind) continue
      const text = excerpt(item.content)
      if (text) return { ...text, source: kind === 'assistant_message' ? 'Last assistant message' : 'Last prompt', origin: 'timeline' }
    }
  }
  return null
}

export function launcherNativeRecap(page: Pick<AgentSessionHistoryPage, 'items'>): LauncherRecap | null {
  for (const kind of ['assistant-message', 'user-message'] as const) {
    for (let index = page.items.length - 1; index >= 0; index -= 1) {
      const item = page.items[index]!
      if (item.kind !== kind) continue
      const text = excerpt(item.contentParts.flatMap(part => part.kind === 'text' ? [part.text] : []).join(' '))
      if (text) return { ...text, source: kind === 'assistant-message' ? 'Last assistant message' : 'Last prompt', origin: 'native' }
    }
  }
  return null
}

export type LauncherNativeCandidate = Pick<AgentSessionRecoveryCandidate,
  'hostId' | 'workspacePath' | 'providerId' | 'executorId' | 'label' | 'createdAt' | 'updatedAt' | 'capabilities'> & {
  native: AgentNativeSessionCandidate
  nativeSessionId: string
}
export type LauncherResumeCandidate = AgentSessionRecoveryCandidate | LauncherNativeCandidate
export function launcherCandidateKey(candidate: LauncherResumeCandidate): string {
  return 'native' in candidate
    ? `native:${encodeURIComponent(candidate.hostId)}:${encodeURIComponent(candidate.providerId)}:${encodeURIComponent(candidate.nativeSessionId)}`
    : candidate.agentSessionId
}
export function launcherCandidateIdentity(candidate: LauncherResumeCandidate): string {
  return 'native' in candidate ? candidate.nativeSessionId : candidate.agentSessionId
}
export type LauncherResumeRow = {
  candidate: LauncherResumeCandidate
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

/** Running Sessions remain resumable even when they already have a Runtime projection. */
export function launcherManagedCandidates(candidates: readonly AgentSessionRecoveryCandidate[], sessions: readonly SessionSnapshot[]): AgentSessionRecoveryCandidate[] {
  const saved = new Map(candidates.map(candidate => [candidate.agentSessionId, candidate]))
  for (const session of sessions) {
    if (session.kind !== 'agent') continue
    saved.set(session.id, { agentSessionId: session.id, hostId: session.hostId, workspacePath: session.workspacePath,
      providerId: session.providerId, executorId: session.executorId, capabilities: session.capabilities,
      label: session.label, createdAt: session.createdAt, updatedAt: session.updatedAt, run: session.control.run,
      ...(session.nativeSessionId ? { nativeSessionId: session.nativeSessionId } : {}),
      ...(session.nativeHandle ? { nativeHandle: session.nativeHandle } : {}) })
  }
  return [...saved.values()]
}

/** The Provider owns discovery; native identities never masquerade as Core Session IDs. */
export function launcherNativeResumeRows(input: {
  catalogs: readonly import('../../../shared/contracts').NativeAgentSessionsResult[]
  managed: readonly AgentSessionRecoveryCandidate[]
  config: AppConfig | null
  topics?: readonly import('../../../shared/scratch-topics').ScratchTopicSnapshot[] | null
  workspace?: WorkspaceRecord | undefined
}): LauncherResumeRow[] {
  const projectId = input.workspace ? workspaceProjectId(input.workspace) : null
  const managed = new Set(input.managed.flatMap(candidate => {
    const id = candidate.nativeSessionId ?? candidate.nativeHandle?.sessionId
    return id ? [JSON.stringify([candidate.hostId, candidate.providerId, id])] : []
  }))
  const rows = new Map<string, LauncherResumeRow>()
  for (const catalog of input.catalogs) for (const native of catalog.sessions) {
    const handle = native.source.nativeHandle
    const key = JSON.stringify([catalog.hostId, handle.providerId, handle.sessionId])
    if (managed.has(key) || rows.has(key)) continue
    const candidate: LauncherNativeCandidate = { native, hostId: catalog.hostId, providerId: handle.providerId, capabilities: catalog.capabilities,
      executorId: native.managed?.executorId ?? catalog.executorId, workspacePath: native.source.workspacePath, nativeSessionId: handle.sessionId,
      label: native.title || `${input.config?.executors[catalog.executorId]?.label ?? catalog.executorId} · ${handle.sessionId}`,
      createdAt: native.createdAt ?? native.updatedAt, updatedAt: native.updatedAt }
    const workspace = input.config?.workspaces.find(item => workspaceOwnsSessionPath(item, candidate, input.topics))
    rows.set(key, { candidate, name: candidate.label, workspace,
      projectName: workspace?.name ?? candidate.workspacePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? candidate.workspacePath,
      hostName: input.config?.hosts.find(host => host.id === catalog.hostId)?.label ?? catalog.hostId,
      executorName: input.config?.executors[candidate.executorId]?.label ?? candidate.executorId,
      recap: null, inProject: Boolean(projectId && workspace && workspaceProjectId(workspace) === projectId),
      stateLabel: native.managed?.state === 'retired' ? 'Saved · Closed' : 'Saved conversation',
      stateDetail: 'Continue this Provider conversation from its original history and directory.' })
  }
  return [...rows.values()]
}

/** Scope follows the registered Project relationship and Host; directory prefixes prove no ownership. */
export function launcherResumeRows(input: {
  candidates: readonly AgentSessionRecoveryCandidate[]
  config: AppConfig | null
  topics?: readonly import('../../../shared/scratch-topics').ScratchTopicSnapshot[] | null
  workspace?: WorkspaceRecord | undefined
  timelines: Readonly<Record<string, AgentTimelineSnapshot>>
  agentNames: Readonly<Record<string, string>>
  sessions: readonly SessionSnapshot[]
  nativeRecaps: Readonly<Record<string, LauncherRecap | null | undefined>>
}): LauncherResumeRow[] {
  const projectId = input.workspace ? workspaceProjectId(input.workspace) : null
  const sessions = new Map(input.sessions.map(session => [session.id, session]))
  return input.candidates.map(candidate => {
    const workspace = input.config?.workspaces.find(item => workspaceOwnsSessionPath(item, candidate, input.topics))
    const timeline = input.timelines[candidate.agentSessionId]
    const session = sessions.get(candidate.agentSessionId)
    const continuity = session?.status.continuity
    const stateLabel = continuity === 'unavailable' ? 'Resume unavailable'
      : continuity === 'conflict' ? 'Recovery conflict'
      : session?.processState === 'running' ? 'Running'
      : session?.processState === 'exited' ? 'Exited'
      : 'Saved · Connection unconfirmed'
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
      stateDetail: continuity === 'unavailable' || continuity === 'conflict' ? session!.status.detail ?? 'The saved Session is kept. Check its recovery status before retrying.'
        : session?.processState === 'running' ? 'This Agent process is running. Continue to reconnect to the same Session.'
        : session?.processState === 'exited' ? 'This Agent process has ended. Continue to resume the saved Session.'
        : 'This Session is saved. Continue to check its connection and resume where you left off.'
    }
  }).sort((left, right) => right.candidate.updatedAt - left.candidate.updatedAt || left.candidate.agentSessionId.localeCompare(right.candidate.agentSessionId))
}

export function filterLauncherResumeRows(rows: readonly LauncherResumeRow[], scope: 'project' | 'global', query: string): LauncherResumeRow[] {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean)
  return rows.filter(row => {
    if (scope === 'project' && !row.inProject) return false
    const haystack = [row.name, row.recap?.text, launcherCandidateIdentity(row.candidate), row.candidate.nativeSessionId, row.candidate.providerId,
      row.executorName, row.candidate.executorId, row.projectName, row.candidate.workspacePath,
      row.hostName, row.candidate.hostId].join(' ').toLocaleLowerCase()
    return terms.every(term => haystack.includes(term))
  })
}

/** A displayed prefix must distinguish these candidates. Full identity stays available in the detail. */
export function launcherResumeShortId(id: string, candidates: readonly LauncherResumeCandidate[]): string {
  let length = Math.min(8, id.length)
  while (length < id.length && candidates.some(candidate => launcherCandidateIdentity(candidate) !== id && launcherCandidateIdentity(candidate).startsWith(id.slice(0, length)))) length += 1
  return length < id.length ? `${id.slice(0, length)}…` : id
}
