import { useCallback, useLayoutEffect, useReducer, useRef, type RefObject } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import { initFollowState } from '@agentmux/client-ui/activity-autoscroll'
import { markProgrammaticReadingScroll } from '@agentmux/client-ui/reading-scroll'
import type { ConversationPresentationController } from '@agentmux/client-ui/use-conversation-record-layout'
import { useHostedConversation } from './use-hosted-conversation'

type Reading = ReturnType<typeof useHostedConversation>
type ReaderOwner = {
  key: string; client: AgentMuxHostedClient | null; id: string | null; reading: Reading | null
  follow: { current: ReturnType<typeof initFollowState> }; presentation: { current: ConversationPresentationController | null }
  intent: { current: number }; scrollTop: number | null; restore: boolean
}
const unavailable = async () => null
const emptyReading: Reading = {
  id: null, session: null, notice: null, disconnected: false, activity: null,
  readProcessDetail: async () => { throw new Error('原阅读来源尚未确认；原工作面保留。') },
  held: false, acceptHeld: () => {}, page: null, timeline: null, projection: null, readError: null,
  readActivity: { sourceRead: null, loading: false }, pageOwner: null, answerContext: null, reading: false,
  olderWindow: false, capturedHasMore: false, newerAvailable: false, refresh: async () => {}, older: unavailable, newer: unavailable, hasNewer: false
}
function sameReading(a: Reading | null, b: Reading) {
  return a !== null && (Object.keys(b) as Array<keyof Reading>).every(key => key === 'readActivity'
    ? a.readActivity.loading === b.readActivity.loading && a.readActivity.sourceRead === b.readActivity.sourceRead
    : a[key] === b[key])
}
/** Keep the original mounted Reader, rather than copying its pages into a second cache. */
function MobileConversationReader({ owner, active, changed }: { owner: ReaderOwner; active: boolean; changed(owner: ReaderOwner): void }) {
  const reading = useHostedConversation(owner.client, owner.id, active,
    frame => owner.presentation.current?.canPresent(frame, { preserveAnchor: !owner.follow.current.following }) !== false)
  useLayoutEffect(() => {
    if (sameReading(owner.reading, reading)) return
    owner.reading = reading
    changed(owner)
  })
  return null
}

/** Visited Mote members park their existing public Reader while hidden. Only the
 * selected reader observes; leaving the exact client/Mote releases every view. */
export function useMobileConversationReading(client: AgentMuxHostedClient | null, id: string | null,
  target: MotePreferencesTarget | undefined, active: boolean, viewport: RefObject<HTMLDivElement | null>) {
  const scopeKey = target ? JSON.stringify([target.spaceId, target.zoneId, target.expectedResource.hostId,
    target.expectedResource.workspaceId, target.expectedResource.workspacePath]) : JSON.stringify(['agent', id])
  const [, redraw] = useReducer(value => value + 1, 0)
  const scope = useRef<{ client: typeof client; key: string; generation: number; owners: ReaderOwner[] }>({ client, key: scopeKey, generation: 0, owners: [] })
  if (scope.current.client !== client || scope.current.key !== scopeKey) {
    // The mounted reader already retains the accepted page's original client.
    // Keep that presentation during a connection swap until a new frame arrives.
    const previous = scope.current.key === scopeKey ? scope.current.owners.find(value => value.id === id) : undefined
    if (previous) previous.client = client
    scope.current = { client, key: scopeKey, generation: scope.current.generation + 1, owners: previous ? [previous] : [] }
  }
  let owner = scope.current.owners.find(value => value.id === id)
  if (!owner) {
    owner = { key: JSON.stringify([scope.current.generation, id]), client, id, reading: null,
      follow: { current: initFollowState() }, presentation: { current: null }, intent: { current: 0 }, scrollTop: null, restore: true }
    scope.current.owners.push(owner)
  }
  const selected = useRef(owner); selected.current = owner
  const changed = useCallback((value: ReaderOwner) => { if (selected.current === value) redraw() }, [])
  const reading = owner.reading ?? emptyReading
  useLayoutEffect(() => {
    const node = viewport.current
    return () => { if (node) owner.scrollTop = node.scrollTop; owner.restore = true }
  }, [owner, active, viewport])
  useLayoutEffect(() => {
    const node = viewport.current
    if (!active || !node || !owner.restore || !reading.pageOwner) return
    node.scrollTop = owner.follow.current.following && !reading.olderWindow ? node.scrollHeight : owner.scrollTop ?? 0
    owner.follow.current = { ...owner.follow.current, lastScrollTop: node.scrollTop }
    markProgrammaticReadingScroll(node)
    owner.restore = false
  }, [owner, active, reading.pageOwner, reading.page, reading.timeline, reading.olderWindow, viewport])
  return { reading, follow: owner.follow, presentation: owner.presentation, presentationIntent: owner.intent, readingKey: owner.key,
    readers: scope.current.owners.map(value => <MobileConversationReader key={value.key} owner={value} active={value === owner && active} changed={changed} />) }
}
