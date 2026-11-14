import { useEffect, useMemo, type ComponentProps } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { agentContextForSession, focusTimelineStamp } from '../lib/focus-context'
import { sessionPresentationById } from '../lib/session-presentation'
import { useAppStore } from '../store'
import { FocusContextRow } from './FocusContextRow'

/** Only an actual body reads the retained recap. Identity, grouping and service
 * detail remain the projection owner's facts, including unconfirmed Mote scope. */
export function FocusContextCardBody(props: ComponentProps<typeof FocusContextRow>) {
  const { context } = props
  useEffect(() => { if (context.access?.readConversation) void context.access.readConversation().catch(error => useAppStore.getState().reportError(error)) }, [context.access?.readConversation])
  const summary = !props.disclosure || props.disclosure.summary > 0
  const facts = useAppStore(useShallow(state => {
    if (context.access || !summary || context.recap !== undefined) return { session: undefined, timeline: undefined, name: undefined }
    const timeline = state.timelines[context.id]
    return { session: sessionPresentationById(state.sessions).get(context.id), timeline,
      name: state.agentNames[context.id], ...focusTimelineStamp(timeline) }
  }))
  const recap = useMemo(() => {
    if (!summary || context.recap !== undefined || !facts.session || facts.session.hostId !== context.hostId) return context.recap
    return agentContextForSession(facts.session, facts.timeline, facts.name, context.workspace, context.topicId).recap
  }, [context, facts, summary])
  const complete = useMemo(() => recap === context.recap ? context : { ...context, recap }, [context, recap])
  return <FocusContextRow {...props} context={complete} />
}
