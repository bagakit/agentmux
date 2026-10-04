import { useLayoutEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { AppConfig, SessionSnapshot, ScratchTopicSnapshot } from '../../../shared/contracts'
import { isScratchWorkspaceId } from '../../../shared/contracts'
import type { WorkbenchTab } from './workbench-tabs'
import type { PersistedWorkbenchTab } from './workbench-persistence'
import { PMO_TEAMS_TOPIC_ID } from '../../../shared/scratch-topics'
import { sameMoteDefaultConversation, type MoteRecoveryTiming } from '../../../shared/mote-quick-mode'
import { useAppStore } from '../store'
import { moteDefaultConversation } from './mote-quick-preferences'
import { scratchTopicKind, scratchTopicsForWorkspace } from './scratch-topic-snapshots'
import { sessionPresentationById } from './session-presentation'
import { agentStartupRecoveryDecision } from './idle-agent-restore-policy'

type State = ReturnType<typeof useAppStore.getState>
type Agent = Extract<SessionSnapshot, { kind: 'agent' }>
type Intent = { cancelled: boolean; setting?: ScratchTopicSnapshot; attempted?: string; release(): void }
type Guard = { cancelled: boolean; current(): boolean }
type Flight = { guards: Set<Guard>; job: Promise<unknown>; dispatched: boolean }
const entries = new Map<string, Set<Intent | Guard>>()
const recovering = new Map<string, Flight>()
const identity = (session: Agent) => JSON.stringify([session.control.hostId, session.control.agentSessionId])
const settingIdentity = (topic: ScratchTopicSnapshot) => {
  const raw = topic.quickMode?.status === 'saved' ? topic.quickMode.defaults.conversation : undefined
  return raw ? JSON.stringify([raw.hostId, raw.sessionId]) : undefined
}
let startup: { intents: Map<string, Intent>; stopped: Map<string, number>; serial: number; attempted: Set<string>; captured: boolean } | undefined

/** Only the lifetime of this application startup; later Save is not another startup. */
export function beginMoteStartupRecovery(): () => void {
  for (const intent of startup?.intents.values() ?? []) intent.release()
  const scope = { intents: new Map<string, Intent>(), stopped: new Map<string, number>(), serial: 0, attempted: new Set<string>(), captured: false }
  startup = scope
  return () => { for (const intent of scope.intents.values()) { intent.cancelled = true; intent.release() }; if (startup === scope) startup = undefined }
}
export function cancelMoteSessionRecovery(sessionId: string): Promise<unknown> | undefined {
  const session = sessionPresentationById(useAppStore.getState().sessions).get(sessionId)
  if (session?.kind !== 'agent') return
  const key = identity(session)
  if (startup) startup.stopped.set(key, ++startup.serial)
  for (const entry of entries.get(key) ?? []) entry.cancelled = true
  return recovering.get(key)?.job
}
export function moteRecoveryTiming(topic: ScratchTopicSnapshot): MoteRecoveryTiming {
  return topic.id === PMO_TEAMS_TOPIC_ID ? 'startup' : topic.quickMode?.status === 'saved' ? topic.quickMode.defaults.recovery ?? 'on-open' : 'on-open'
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
function sameSetting(a: ScratchTopicSnapshot, b: ScratchTopicSnapshot): boolean {
  const raw = (topic: ScratchTopicSnapshot) => topic.quickMode?.status === 'saved' ? topic.quickMode.defaults.conversation : undefined
  return a.directoryPath === b.directoryPath && sameMoteDefaultConversation(raw(a), raw(b)) && moteRecoveryTiming(a) === moteRecoveryTiming(b)
}
function holdIntent(workspaceId: string, topicId: string, initial?: ScratchTopicSnapshot): Intent {
  const intent: Intent = { cancelled: false, ...(initial ? { setting: initial } : {}), release: () => {} }
  const scope = startup, openedAt = scope?.serial ?? 0
  let registered: string | undefined
  const confirm = (state: State) => {
    const actual = confirmedTopic(state, workspaceId, topicId)
    if (!actual) return
    if (!intent.setting) intent.setting = actual
    else if (!sameSetting(intent.setting, actual)) intent.cancelled = true
    const key = settingIdentity(intent.setting)
    if (key && (scope?.stopped.get(key) ?? 0) > openedAt) intent.cancelled = true
    if (key && !registered) { const set = entries.get(key) ?? new Set(); set.add(intent); entries.set(key, set); registered = key }
  }
  confirm(useAppStore.getState())
  let snapshot = useAppStore.getState().scratchTopicSnapshots[workspaceId]
  const unsubscribe = useAppStore.subscribe(state => { if (snapshot !== state.scratchTopicSnapshots[workspaceId]) { snapshot = state.scratchTopicSnapshots[workspaceId]; confirm(state) } })
  intent.release = () => { unsubscribe(); if (registered) { const set = entries.get(registered); set?.delete(intent); if (!set?.size) entries.delete(registered) } }
  return intent
}

/** Multiple display bindings do not turn one exact original Session into multiple recovery requests. */
export function moteSessionStartupMode(state: State, session: Agent): MoteRecoveryTiming | 'ordinary' | 'pending' {
  let fixed: MoteRecoveryTiming | undefined, unknown = false
  const owners = new Set(Object.values(state.tabs).filter(tab => tab.topicId && Object.values(tab.regions).some(region => region.kind === 'agent' && region.sessionId === session.id))
    .map(tab => JSON.stringify([tab.workspaceId, tab.topicId])))
  for (const key of owners) {
    const [workspaceId, topicId] = JSON.parse(key) as [string, string]
    if (!state.config?.workspaces.some(item => item.id === workspaceId && isScratchWorkspaceId(item.id))) continue
    const topic = confirmedTopic(state, workspaceId, topicId)
    if (!topic) { unknown = true; continue }
    if (scratchTopicKind(topic.id, [topic]) !== 'mote') continue
    const raw = topic.quickMode?.status === 'saved' ? topic.quickMode.defaults.conversation : undefined
    if (!raw || raw.sessionId !== session.control.agentSessionId || raw.hostId !== session.control.hostId) continue
    const resolved = moteDefaultConversation(state, topic, workspaceId)
    if (!resolved.conversation || resolved.issue) { unknown = true; continue }
    const timing = moteRecoveryTiming(topic)
    if (timing === 'startup') return timing
    fixed = timing
  }
  return fixed ?? (unknown ? 'pending' : 'ordinary')
}
async function recoverOriginal(session: Agent, current: () => boolean): Promise<boolean> {
  if (!current() || session.processState === 'running' || !hostAvailable(useAppStore.getState(), session.control.hostId)) return false
  const key = identity(session), guard: Guard = { cancelled: false, current }
  const listeners = entries.get(key) ?? new Set(); listeners.add(guard); entries.set(key, listeners)
  let flight = recovering.get(key)
  if (flight) flight.guards.add(guard)
  else {
    const guards = new Set([guard]), admitted = () => [...guards].some(item => !item.cancelled && item.current())
    const created: Flight = { guards, dispatched: false, job: Promise.resolve() }
    created.job = Promise.resolve().then(() => {
      if (!admitted()) return
      created.dispatched = true
      return useAppStore.getState().recoverSession(session.id, crypto.randomUUID(), { preserveView: true, stillCurrent: admitted })
    }).finally(() => { if (recovering.get(key) === created) recovering.delete(key) })
    recovering.set(key, created); flight = created
  }
  try { await flight.job } catch { /* Original Store owns the retained recovery service window. */ }
  finally { flight.guards.delete(guard); listeners.delete(guard); if (!listeners.size) entries.delete(key) }
  return flight.dispatched
}
function captureStartup(): void {
  const state = useAppStore.getState(), scope = startup
  if (!scope || scope.captured) return
  if (state.config?.workspaces.some(workspace => isScratchWorkspaceId(workspace.id) &&
    (state.scratchTopicSnapshots[workspace.id]?.reading || state.scratchTopicSnapshots[workspace.id]?.discoveryError || !scratchTopicsForWorkspace(state.scratchTopicSnapshots, workspace)))) return
  scope.captured = true
  for (const workspace of state.config?.workspaces ?? []) {
    if (!isScratchWorkspaceId(workspace.id)) continue
    for (const topic of scratchTopicsForWorkspace(state.scratchTopicSnapshots, workspace) ?? []) {
      if (scratchTopicKind(topic.id, [topic]) === 'mote') scope.intents.set(JSON.stringify([workspace.id, topic.id]), holdIntent(workspace.id, topic.id))
    }
  }
}
/** One canonical candidate, once per startup; late membership settles the captured preference. */
export async function recoverMoteConversationAtStartup(session: Agent): Promise<void> {
  captureStartup()
  const scope = startup, state = useAppStore.getState(), key = identity(session)
  if (!scope?.captured || scope.stopped.has(key) || scope.attempted.has(key)) return
  const mode = moteSessionStartupMode(state, session)
  if (mode !== 'startup' && (mode !== 'ordinary' || agentStartupRecoveryDecision({ runState: session.processState, canonical: hostAvailable(state, session.control.hostId), ...(session.semanticStatus ? { semanticStatus: session.semanticStatus } : {}), now: Date.now() }).kind !== 'resume')) return
  const eligible = () => {
    const next = useAppStore.getState(), live = sessionPresentationById(next.sessions).get(session.id)
    if (startup !== scope || scope.stopped.has(key) || live?.kind !== 'agent' || identity(live) !== key || moteSessionStartupMode(next, live) !== mode) return false
    if ([...scope.intents.values()].some(intent => intent.cancelled && intent.setting && settingIdentity(intent.setting) === key)) return false
    if (mode === 'ordinary') return true
    return [...scope.intents.values()].some(intent => !intent.cancelled && intent.setting && settingIdentity(intent.setting) === key && moteRecoveryTiming(intent.setting) === 'startup')
  }
  if (!eligible()) return
  scope.attempted.add(key)
  if (!await recoverOriginal(session, eligible)) scope.attempted.delete(key)
}
/** Called after the original workface and initial fresh directory cut are published. */
export async function recoverScratchConversationsAtStartup(): Promise<void> {
  captureStartup()
  const state = useAppStore.getState()
  await Promise.all(state.sessions.flatMap(session => session.kind === 'agent' && deferScratchConversationRecovery(state.tabs, state.config, session.id) ? [recoverMoteConversationAtStartup(session)] : []))
}
/** One genuine open; preview, Save and retained hidden surfaces do not create another intent. */
export function useMoteConversationRecovery(topic: ScratchTopicSnapshot | undefined, workspaceId: string, opened: boolean): void {
  const entry = useRef<{ key: string; intent: Intent } | null>(null)
  const raw = topic?.quickMode?.status === 'saved' ? topic.quickMode.defaults.conversation : undefined
  const facts = useAppStore(useShallow(state => {
    if (!opened) return null
    const tab = raw ? state.tabs[raw.tabId] : undefined, region = raw ? tab?.regions[raw.regionId] : undefined
    const session = region?.kind === 'agent' ? sessionPresentationById(state.sessions).get(region.sessionId) : undefined
    return { tab, layout: raw ? state.layouts[raw.displayWorkspaceId] : undefined, config: state.config,
      binding: tab?.space?.zoneId ? state.spaceZoneBindings[tab.space.zoneId] : undefined,
      loading: state.loading, snapshot: state.scratchTopicSnapshots[workspaceId],
      session: session?.kind === 'agent' ? JSON.stringify([session.id, session.control, session.processState, hostAvailable(state, session.control.hostId)]) : null }
  }))
  useLayoutEffect(() => {
    const key = JSON.stringify([workspaceId, topic?.id])
    if (!opened || entry.current?.key !== key) { if (entry.current) { entry.current.intent.cancelled = true; entry.current.intent.release() }; entry.current = null }
    if (!opened || !topic) return
    if (!entry.current) entry.current = { key, intent: holdIntent(workspaceId, topic.id) }
    const intent = entry.current.intent, held = intent.setting
    if (intent.cancelled || !held || !raw || !sameSetting(held, topic)) return
    const state = useAppStore.getState(), actual = confirmedTopic(state, workspaceId, topic.id)
    if (state.loading || !actual) return
    const resolved = moteDefaultConversation(state, actual, workspaceId)
    if (!resolved.conversation || resolved.issue) return
    const region = state.tabs[raw.tabId]?.regions[raw.regionId], session = region?.kind === 'agent' ? sessionPresentationById(state.sessions).get(region.sessionId) : undefined
    if (session?.kind !== 'agent' || !hostAvailable(state, session.control.hostId)) return
    const attempt = identity(session)
    if (intent.attempted === attempt || session.processState === 'running') return
    intent.attempted = attempt
    void recoverOriginal(session, () => {
      const now = useAppStore.getState(), currentTopic = confirmedTopic(now, workspaceId, topic.id)
      const current = currentTopic && moteDefaultConversation(now, currentTopic, workspaceId)
      return !intent.cancelled && entry.current?.intent === intent && !now.loading && Boolean(current?.conversation && !current.issue && currentTopic && sameSetting(held, currentTopic))
    }).then(dispatched => { if (!dispatched && intent.attempted === attempt) delete intent.attempted })
  }, [opened, topic, workspaceId, raw, facts])
  useLayoutEffect(() => () => { if (entry.current) { entry.current.intent.cancelled = true; entry.current.intent.release(); entry.current = null } }, [])
}
