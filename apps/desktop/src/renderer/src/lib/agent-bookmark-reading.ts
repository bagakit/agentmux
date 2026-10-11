import { useEffect, useMemo, useRef } from 'react'
import type { SessionSnapshot } from '../../../shared/contracts'
import { nativeBindingKey } from '../../../shared/agent-native-source'
import { useAppStore } from '../store'
import { agentBookmarks } from './agent-bookmarks'
import { agentContextForSession } from './focus-context'
import { createFocusGoalLinksSelector, focusGoalCardKey } from './focus-goal-links'
import type { AgentInformationPreview } from './agent-information-preview'
import { workspaceForSession } from './workbench-tabs'

let indexedSessions: readonly SessionSnapshot[] | undefined
let bySubject = new Map<string, readonly Extract<SessionSnapshot, { kind: 'agent' }>[]>()
function subjectSessions(sessions: readonly SessionSnapshot[], host: string, sid: string) {
  if (sessions !== indexedSessions) {
    bySubject = new Map()
    for (const session of sessions) if (session.kind === 'agent') {
      const key = JSON.stringify([session.control.hostId, session.control.agentSessionId])
      bySubject.set(key, [...bySubject.get(key) ?? [], session])
    }
    indexedSessions = sessions
  }
  return bySubject.get(JSON.stringify([host, sid]))
}
const goals = createFocusGoalLinksSelector()

/** Live presentation follows only the saved canonical subject; it never resumes or creates a Run. */
export function useAgentBookmarkReading(opening: AgentInformationPreview, visible: boolean): AgentInformationPreview {
  const bookmark = opening.bookmark
  const session = useAppStore(state => {
    if (!bookmark || !visible) return undefined
    const candidates = subjectSessions(state.sessions, bookmark.hostId, bookmark.agentSessionId)
    return candidates?.find(item => item.id === bookmark.presentationId) ?? candidates?.[0]
  })
  const timeline = useAppStore(state => session ? state.timelines[session.id] : undefined)
  const name = useAppStore(state => session ? state.agentNames[session.id] : undefined)
  const config = useAppStore(state => session && visible ? state.config : null)
  const links = useAppStore(state => bookmark && session && visible ? goals(state).get(focusGoalCardKey(session.hostId, session.id)) : undefined)
  const context = useMemo(() => session ? agentContextForSession(session, timeline, name, workspaceForSession(config, session), opening.context.topicId) : opening.context,
    [session, timeline, name, config, opening.context])
  const lastObserved = useRef(context)
  if (session && visible) lastObserved.current = context
  const observedContext = bookmark && !session ? lastObserved.current : context
  useEffect(() => {
    if (bookmark && session && visible) agentBookmarks.updateSnapshot(bookmark.key, { label: context.name, workspaceName: context.workspaceName,
      excerpt: context.recap?.reading?.text ?? context.recap?.text })
  }, [bookmark?.key, visible, Boolean(session), context.name, context.workspaceName, context.recap?.reading?.text, context.recap?.text])
  return useMemo(() => !bookmark ? opening : { ...opening, context: observedContext, session, control: session?.control,
    sourceKey: session ? nativeBindingKey(session) : undefined, goalLinks: links,
    openWorkface() { if (session) useAppStore.getState().selectSession(session.id) } }, [opening, bookmark, observedContext, session, links])
}
