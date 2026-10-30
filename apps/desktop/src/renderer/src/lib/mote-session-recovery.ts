import type { AppConfig, SessionSnapshot, ScratchTopicSnapshot } from '../../../shared/contracts'
import { isScratchWorkspaceId } from '../../../shared/contracts'
import type { WorkbenchTab } from './workbench-tabs'
import type { PersistedWorkbenchTab } from './workbench-persistence'
import { useAppStore } from '../store'
import { scratchTopicKind, scratchTopicsForWorkspace } from './scratch-topic-snapshots'
import { sessionPresentationById } from './session-presentation'

type State = ReturnType<typeof useAppStore.getState>
type Agent = Extract<SessionSnapshot, { kind: 'agent' }>
const identity = (session: Agent) => JSON.stringify([session.control.hostId, session.control.agentSessionId])
let startup: { stopped: Set<string>; attempted: Set<string>; jobs: Map<string,Promise<unknown>> } | undefined
/** Renderer restores ordinary original workfaces. The Host owns Mote role maintenance. */
export function beginMoteStartupRecovery(): () => void {
  const scope = { stopped: new Set<string>(), attempted: new Set<string>(), jobs: new Map<string,Promise<unknown>>() }
  startup = scope
  return () => { if (startup === scope) startup = undefined }
}
export function cancelMoteSessionRecovery(sessionId: string): Promise<unknown> | undefined {
  const session = sessionPresentationById(useAppStore.getState().sessions).get(sessionId)
  if (session?.kind !== 'agent') return
  const key = identity(session); startup?.stopped.add(key)
  return startup?.jobs.get(key)
}
/** Delay saved Scratch references until original directory facts distinguish fixed from ordinary recovery. */
export function deferScratchConversationRecovery(tabs: Readonly<Record<string, WorkbenchTab | PersistedWorkbenchTab>>, config: AppConfig | null, sessionId: string, sessions: readonly SessionSnapshot[] = []): boolean {
  const known = sessionPresentationById(sessions)
  return Object.values(tabs).some(tab => Boolean(tab.topicId) && config?.workspaces.some(workspace => workspace.id === tab.workspaceId && isScratchWorkspaceId(workspace.id)) &&
    Object.values(tab.regions).some(region => region.kind === 'agent' && (region.sessionId === sessionId || (() => {
      const session = known.get(region.sessionId); return session?.kind === 'agent' && session.control.agentSessionId === sessionId
    })())))
}
const hostAvailable = (state: State, hostId: string) => !state.runtimeEndpointWarnings?.some(warning => warning.hostId === hostId && warning.scope !== 'observation' && warning.availability !== 'connected')
function confirmedTopic(state: State, workspaceId: string, topicId: string): ScratchTopicSnapshot | undefined {
  const workspace = state.config?.workspaces.find(item => item.id === workspaceId), snapshot = state.scratchTopicSnapshots[workspaceId]
  const topic = scratchTopicsForWorkspace(state.scratchTopicSnapshots, workspace)?.find(item => item.id === topicId)
  // Aggregate error also includes unrelated directories. Only this resource's facts admit recovery.
  return snapshot?.reading || snapshot?.discoveryError || topic?.readError || !topic || scratchTopicKind(topic.id, [topic]) === 'mote' && (!topic.quickMode || topic.quickMode.status === 'unconfirmed') ? undefined : topic
}

export function moteSessionStartupMode(state: State, session: Agent): 'host-managed' | 'member' | 'ordinary' | 'pending' {
  let moteMember = false, unknown = false
  const owners = new Set(Object.values(state.tabs).filter(tab => tab.topicId && Object.values(tab.regions).some(region => region.kind === 'agent' && region.sessionId === session.id))
    .map(tab => JSON.stringify([tab.workspaceId, tab.topicId])))
  for (const key of owners) {
    const [workspaceId, topicId] = JSON.parse(key) as [string, string]
    if (!state.config?.workspaces.some(item => item.id === workspaceId && isScratchWorkspaceId(item.id))) continue
    const topic = confirmedTopic(state, workspaceId, topicId)
    if (!topic) { unknown = true; continue }
    if (scratchTopicKind(topic.id, [topic]) !== 'mote') continue
    moteMember = true
    const current = topic.quickMode?.status === 'saved' ? topic.quickMode.defaults.conversation : undefined
    // Original MOTE identity, Host and SID establish the role; a missing/old
    // presentation occurrence does not authorize another lifecycle owner.
    if (current?.sessionId === session.control.agentSessionId && current.hostId === session.control.hostId) return 'host-managed'
  }
  return unknown ? 'pending' : moteMember ? 'member' : 'ordinary'
}
export async function recoverMoteConversationAtStartup(session: Agent): Promise<void> {
  const scope = startup, state = useAppStore.getState(), key = identity(session)
  if (!scope || scope.stopped.has(key) || scope.attempted.has(key) || session.processState === 'running' ||
    !hostAvailable(state, session.control.hostId) || moteSessionStartupMode(state, session) !== 'ordinary') return
  const current = () => {
    const now = useAppStore.getState(), live = sessionPresentationById(now.sessions).get(session.id)
    return startup === scope && !scope.stopped.has(key) && live?.kind === 'agent' && identity(live) === key &&
      moteSessionStartupMode(now, live) === 'ordinary' && hostAvailable(now, live.control.hostId)
  }
  if (!current()) return
  scope.attempted.add(key)
  const job = useAppStore.getState().recoverSession(session.id, undefined, { preserveView: true, stillCurrent: current, trigger: 'startup' })
  scope.jobs.set(key, job)
  try { await job } catch { /* The original Store retains the service window and operation. */ }
  finally { if (scope.jobs.get(key) === job) scope.jobs.delete(key) }
}
/** Original directory reads settle ordinary references; Mote primary/member reads never wake Agents. */
export async function recoverScratchConversationsAtStartup(): Promise<void> {
  const state = useAppStore.getState()
  await Promise.all(state.sessions.flatMap(session => session.kind === 'agent' && deferScratchConversationRecovery(state.tabs, state.config, session.id) ? [recoverMoteConversationAtStartup(session)] : []))
}
