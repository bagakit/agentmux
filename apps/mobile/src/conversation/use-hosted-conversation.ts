import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConversationView } from '@agentmux/client-ui/use-conversation-view'
import { describeConversationWindow, projectConversationWindow } from '@agentmux/client-ui/conversation-records'
import { mobileCapability, type MobileConversationClient } from './mobile-conversation-client'
import type { AgentMuxAgentSession, AgentSessionHistoryPage } from '@agentmux/core'
import { agentEvidenceStale, msUntilSemanticStatusStale, type AgentObservation } from '@agentmux/core/agent-status'
import { readMobileConversationSession, type MobileConversationMetadata } from './mobile-conversation-session'

/** `paired` says whether this device holds a Mac connection link; absent when the owner has not established it. */
export type MobileConnection = { state: 'unavailable' | 'connecting' | 'connected' | 'disconnected'; message: string; issue?: string; paired?: boolean }
type PageOwner = { client: MobileConversationClient; agentSessionId: string; hostId?: string; workspacePath?: string }
type Metadata = { owner: MobileConversationClient | null; id: string | null; session: AgentMuxAgentSession | null; metadata: MobileConversationMetadata; agentIssue: string | null; disconnected: boolean;
  activity: { owner: object; hostId: string; runId: string; observation: AgentObservation } | null }
const empty = (id: string | null, owner: MobileConversationClient | null): Metadata => {
  // Keep an already accepted bootstrap binding usable while the exact read is
  // pending. Cached data neither confirms metadata nor clears an earlier issue.
  let session: AgentMuxAgentSession | null = null
  try { const cached = id && owner ? mobileCapability(owner, 'agentSession')(id) : null; if (cached?.agentSessionId === id) session = cached } catch { /* Point reading owns the result. */ }
  return { owner, id, session, metadata: { state: 'loading', issue: null }, agentIssue: null, disconnected: false, activity: null }
}
const sameSource = (a: AgentSessionHistoryPage, b: AgentSessionHistoryPage) => a.agentSessionId === b.agentSessionId && a.sourceHostId === b.sourceHostId && a.source.providerId === b.source.providerId && a.source.nativeSessionId === b.source.nativeSessionId

/** Complete accepted public Reader frames; transport loss retains the original view and resource owner. */
export function useHostedConversation(client: MobileConversationClient | null, id: string | null, active: boolean,
  beforeCommit?: (frame: ReturnType<typeof projectConversationWindow>) => boolean) {
  const [metadata, setMetadata] = useState<Metadata>(() => empty(id, client))
  const selected = metadata.id === id && metadata.owner === client ? metadata : empty(id, client)
  const activityOwner = useMemo(() => ({}), [client, id, active])
  const view = useConversationView(client, id ? { hostId: 'local', agentSessionId: id } : undefined, active, {
    beforeCommit: snapshot => beforeCommit?.(projectConversationWindow(snapshot)) !== false
  })
  const reading = useMemo(() => view.reading ? describeConversationWindow(view.reading) : null, [view.reading])
  const pageOwner = useRef<{ snapshot: typeof view.snapshot; owner: PageOwner } | null>(null)
  // A retained frame keeps its original client until that client supplies a newly accepted frame.
  if (view.snapshot && view.snapshot !== pageOwner.current?.snapshot && client && id) {
    pageOwner.current = { snapshot: view.snapshot, owner: { client, agentSessionId: id,
      ...(selected.session ? { hostId: selected.session.hostId, workspacePath: selected.session.workspacePath } : {}) } }
  }
  const hasQuestion = reading?.historyPage?.items.some(item => item.questionRequest !== undefined) === true
  const answers = useConversationView(client, id ? { hostId: 'local', agentSessionId: id } : undefined,
    active && view.historical && hasQuestion, { identity: 'question-answer-context' })
  const answerPage = answers.reading?.historyPage ?? null
  const answerContext = answerPage && reading?.historyPage && sameSource(answerPage, reading.historyPage) ? answerPage : reading?.historyPage ?? null

  const metadataScope = useRef({ client, id, mounted: true })
  metadataScope.current.client = client; metadataScope.current.id = id
  const metadataEpoch = useRef(0)
  useEffect(() => { metadataScope.current.mounted = true; return () => { metadataScope.current.mounted = false } }, [])
  const readMetadata = useCallback(async () => {
    if (!client || !id) return null
    const generation = ++metadataEpoch.current
    const expectedOwner = client.runtimeOwnerIdentity?.()
    const result = await readMobileConversationSession(client, id)
    const currentOwner = client.runtimeOwnerIdentity?.()
    if (!metadataScope.current.mounted || metadataScope.current.client !== client || metadataScope.current.id !== id || generation !== metadataEpoch.current ||
        (['runtimeId', 'ownerInstanceId'] as const).some(key => expectedOwner?.[key] && expectedOwner[key] !== currentOwner?.[key])) return null
    setMetadata(previous => {
      const original = previous.id === id && previous.owner === client ? previous : empty(id, client)
      return { ...original, session: result.metadata.state === 'unconfirmed' ? original.session : result.session, metadata: result.metadata }
    })
    return result
  }, [client, id])
  useEffect(() => {
    let live = true, epoch = 0, readingActivity = false, dirty = false
    let expiry: ReturnType<typeof setTimeout> | undefined
    let latestSession = selected.session
    setMetadata(value => value.id === id && value.owner === client ? value : empty(id, client))
    if (!client || !id || !active) return
    const patch = (next: Partial<Metadata>) => { if (live) setMetadata(value => ({ ...(value.id === id && value.owner === client ? value : empty(id, client)), ...next })) }
    function clearActivity() { epoch++; if (expiry) clearTimeout(expiry); expiry = undefined; patch({ activity: null }) }
    async function sessionMetadata(): Promise<void> {
      const result = await readMetadata()
      if (!live || !result) return
      latestSession = result.metadata.state === 'unconfirmed' ? latestSession : result.session
      if (latestSession && result.metadata.state === 'active') void readActivity()
      else clearActivity()
    }
    async function readActivity(): Promise<void> {
      if (!live || document.hidden || !latestSession) return
      const generation = ++epoch
      if (readingActivity) { dirty = true; return }
      readingActivity = true
      try {
        const original = latestSession!, expectedOwner = client!.runtimeOwnerIdentity?.()
        const value = await mobileCapability(client!, 'statusAgent')(id!)
        if (!live || generation !== epoch) return
        // A status reply describes its original Run. Verify that the selected
        // Session still owns that Run before presenting the reply as current.
        const current = await readMetadata(), currentOwner = client!.runtimeOwnerIdentity?.()
        if (!live || generation !== epoch) return
        if (current && current.metadata.state !== 'unconfirmed') latestSession = current.session
        if (!current || current.metadata.state !== 'active' || !current.session ||
          (['runtimeId', 'ownerInstanceId'] as const).some(key => expectedOwner?.[key] && expectedOwner[key] !== currentOwner?.[key]) ||
          current.session.hostId !== original.hostId || current.session.run.runId !== original.run.runId ||
          value.session.agentSessionId !== id || original.agentSessionId !== id || value.session.hostId !== original.hostId ||
          value.session.run.runId !== original.run.runId || value.run.runId !== original.run.runId) { clearActivity(); return }
        if (expiry) clearTimeout(expiry); expiry = undefined
        const { observation } = value
        if (observation.semantic === 'active' && agentEvidenceStale(observation, Date.now())) { clearActivity(); return }
        patch({ activity: { owner: activityOwner, hostId: original.hostId, runId: original.run.runId, observation } })
        if (observation.semantic === 'active') expiry = setTimeout(() => { if (live && generation === epoch) clearActivity() },
          msUntilSemanticStatusStale({ state: 'working', observedAt: observation.observedAt }, Date.now()))
      } catch { if (live && generation === epoch) clearActivity() }
      finally { readingActivity = false; if (live && dirty) { dirty = false; void readActivity() } }
    }
    const unlisten = client.onEvent?.(event => {
      if (!live) return
      if (event.type === 'connection-state') {
        clearActivity(); patch({ disconnected: event.state !== 'restored' })
        if (event.state === 'restored') { void sessionMetadata(); void view.resume(); if (hasQuestion) void answers.resume() }
      } else if (event.type === 'agent-session' && event.session.agentSessionId === id) {
        clearActivity(); void sessionMetadata()
      } else if ((event.type === 'agent-status' || event.type === 'process-state') && event.agentSessionId === id) {
        clearActivity(); void readActivity()
      } else if (event.type === 'agent-error' && (!event.agentSessionId || event.agentSessionId === id)) {
        patch({ agentIssue: event.message })
      } else if (event.type === 'run-removed' && (event.agentSessionId === id || event.run.runId === latestSession?.run.runId) || event.type === 'agent-session-record-deleted' && event.agentSessionId === id) {
        clearActivity(); void sessionMetadata()
      }
    })
    const foreground = () => { if (document.hidden) clearActivity(); else void readActivity() }
    document.addEventListener('visibilitychange', foreground)
    void sessionMetadata()
    return () => { live = false; if (expiry) clearTimeout(expiry); document.removeEventListener('visibilitychange', foreground); unlisten?.() }
  }, [client, id, active, activityOwner, view.resume, answers.resume, hasQuestion, readMetadata])
  const refresh = useCallback(async (includeMetadata = true) => { await Promise.all([view.refresh(), ...(includeMetadata ? [readMetadata()] : [])]) }, [view.refresh, readMetadata])
  const activity = active && selected.activity?.owner === activityOwner &&
    selected.activity.hostId === selected.session?.hostId && selected.activity.runId === selected.session?.run.runId ? selected.activity.observation : null
  return { id: selected.id, metadataClient: selected.owner, agentIssue: selected.agentIssue, session: selected.session, metadata: selected.metadata, disconnected: selected.disconnected, activity, readProcessDetail: view.readProcessDetail, held: view.held, acceptHeld: view.acceptHeld, page: reading?.historyPage ?? null, timeline: reading?.captured ?? null, projection: reading,
    readError: view.error, readActivity: { sourceRead: view.sourceRead, loading: view.loading },
    pageOwner: view.snapshot ? pageOwner.current?.owner ?? null : null, answerContext, reading: view.loading,
    olderWindow: view.historical, capturedHasMore: view.hasMore, newerAvailable: view.newerAvailable || view.held,
    notice: view.error?.message ?? view.observationError?.message ?? answers.error?.message ?? null,
    refresh, older: view.earlier, newer: view.newer, hasNewer: view.hasNewer }
}
