import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConversationView } from '@agentmux/client-ui/use-conversation-view'
import { describeConversationWindow, projectConversationWindow } from '@agentmux/client-ui/conversation-records'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxAgentSession, AgentSessionHistoryPage } from '@agentmux/core'
import { agentEvidenceStale, msUntilSemanticStatusStale, type AgentObservation } from '@agentmux/core/agent-status'
import { errorMessage } from './delivery'

export type MobileConnection = { state: 'unavailable' | 'connecting' | 'connected' | 'disconnected'; message: string; issue?: string }
type PageOwner = { client: AgentMuxHostedClient; agentSessionId: string; hostId?: string; workspacePath?: string }
type Metadata = { id: string | null; session: AgentMuxAgentSession | null; notice: string | null; disconnected: boolean;
  activity: { owner: object; hostId: string; runId: string; observation: AgentObservation } | null }
const empty = (id: string | null): Metadata => ({ id, session: null, notice: null, disconnected: false, activity: null })
const sameSource = (a: AgentSessionHistoryPage, b: AgentSessionHistoryPage) => a.agentSessionId === b.agentSessionId && a.sourceHostId === b.sourceHostId && a.source.providerId === b.source.providerId && a.source.nativeSessionId === b.source.nativeSessionId

/** Complete accepted public Reader frames; transport loss retains the original view and resource owner. */
export function useHostedConversation(client: AgentMuxHostedClient | null, id: string | null, active: boolean,
  beforeCommit?: (frame: ReturnType<typeof projectConversationWindow>) => boolean) {
  const [metadata, setMetadata] = useState<Metadata>(() => empty(id))
  const selected = metadata.id === id ? metadata : empty(id)
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

  useEffect(() => {
    let live = true, epoch = 0, readingActivity = false, dirty = false
    let expiry: ReturnType<typeof setTimeout> | undefined
    setMetadata(value => value.id === id ? value : empty(id))
    if (!client || !id || !active) return
    const patch = (next: Partial<Metadata>) => { if (live) setMetadata(value => ({ ...(value.id === id ? value : empty(id)), ...next })) }
    function clearActivity() { epoch++; if (expiry) clearTimeout(expiry); expiry = undefined; patch({ activity: null }) }
    function sessionMetadata() {
      try {
        const session = client!.agentSession(id!)
        if (session.agentSessionId !== id) throw new Error('The Host returned another Session’s metadata. The original reading is retained.')
        patch({ session })
      } catch (error) { patch({ notice: errorMessage(error) }) }
    }
    async function readActivity(): Promise<void> {
      if (!live || document.hidden) return
      const generation = ++epoch
      if (readingActivity) { dirty = true; return }
      readingActivity = true
      try {
        const value = await client!.statusAgent(id!), original = client!.agentSession(id!)
        if (!live || generation !== epoch) return
        if (value.session.agentSessionId !== id || original.agentSessionId !== id || value.session.hostId !== original.hostId ||
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
    const unlisten = client.onEvent(event => {
      if (!live) return
      if (event.type === 'connection-state') {
        clearActivity(); patch({ disconnected: event.state !== 'restored', notice: event.state === 'restored' ? null :
          'The original Host is unreachable. Reading and drafts are retained; unconfirmed writes are not resent.' })
        if (event.state === 'restored') { sessionMetadata(); void readActivity(); void view.resume(); if (hasQuestion) void answers.resume() }
      } else if (event.type === 'agent-session' && event.session.agentSessionId === id) {
        sessionMetadata(); clearActivity(); void readActivity()
      } else if ((event.type === 'agent-status' || event.type === 'process-state') && event.agentSessionId === id) {
        clearActivity(); void readActivity()
      } else if (event.type === 'agent-error' && (!event.agentSessionId || event.agentSessionId === id)) patch({ notice: event.message })
    })
    const foreground = () => { if (document.hidden) clearActivity(); else void readActivity() }
    document.addEventListener('visibilitychange', foreground)
    sessionMetadata(); void readActivity()
    return () => { live = false; if (expiry) clearTimeout(expiry); document.removeEventListener('visibilitychange', foreground); unlisten() }
  }, [client, id, active, activityOwner, view.resume, answers.resume, hasQuestion])
  const refresh = useCallback(() => view.refresh(), [view.refresh])
  const activity = active && selected.activity?.owner === activityOwner &&
    selected.activity.hostId === selected.session?.hostId && selected.activity.runId === selected.session?.run.runId ? selected.activity.observation : null
  return { ...selected, activity, readProcessDetail: view.readProcessDetail, held: view.held, acceptHeld: view.acceptHeld, page: reading?.historyPage ?? null, timeline: reading?.captured ?? null, projection: reading,
    readError: view.error, readActivity: { sourceRead: view.sourceRead, loading: view.loading },
    pageOwner: view.snapshot ? pageOwner.current?.owner ?? null : null, answerContext, reading: view.loading,
    olderWindow: view.historical, capturedHasMore: view.hasMore, newerAvailable: view.newerAvailable || view.held,
    notice: view.error?.message ?? view.observationError?.message ?? answers.error?.message ?? selected.notice,
    refresh, older: view.earlier, newer: view.newer, hasNewer: view.hasNewer }
}
