import { memo, useEffect, useMemo, type ComponentProps } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { agentContextForSession, focusTimelineStamp } from '../lib/focus-context'
import { sessionPresentationById } from '../lib/session-presentation'
import { useAppStore } from '../store'
import { FocusContextRow } from './FocusContextRow'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'

/** Only an actual body reads the retained recap. Identity, grouping and service
 * detail remain the projection owner's facts, including unconfirmed Mote scope. */
export const FocusContextCardBody = memo(function FocusContextCardBody({ summaryActive = true, ...props }: ComponentProps<typeof FocusContextRow> & { summaryActive?: boolean }) {
  const { context } = props
  const presentationActive = useWorkbenchPresentationActive(), active = summaryActive && presentationActive && !props.list
  useEffect(() => { if (active && context.access?.readConversation) void context.access.readConversation().catch(error => useAppStore.getState().reportError(error)) }, [active, context.access?.readConversation])
  const summary = !props.disclosure || props.disclosure.summary > 0
  const facts = useAppStore(useShallow(state => {
    if (!active || context.access || !summary || context.recap !== undefined) return { session: undefined, timeline: undefined, name: undefined }
    const timeline = state.timelines[context.id]
    return { session: sessionPresentationById(state.sessions).get(context.id), timeline,
      name: state.agentNames[context.id], ...focusTimelineStamp(timeline) }
  }))
  const recap = useMemo(() => {
    if (!summary || context.recap !== undefined || !facts.session || facts.session.hostId !== context.hostId) return context.recap
    return agentContextForSession(facts.session, facts.timeline, facts.name, context.workspace, context.topicId).recap
  }, [context, facts, summary])
  const complete = useMemo(() => recap === context.recap ? context : { ...context, recap }, [context, recap])
  function resolveListPreview() {
    // Source readers carry their own references. The shared reader consumes
    // that exact conversation on demand; a same-SID local cache cannot fill it.
    if (context.access || context.recap !== undefined) return context
    const state = useAppStore.getState()
    const session = sessionPresentationById(state.sessions).get(context.id)
    if (!session || session.hostId !== context.hostId || session.control.run.runId !== context.runId) return context
    const held = agentContextForSession(session, state.timelines[context.id], state.agentNames[context.id], context.workspace, context.topicId)
    return { ...context, recap: held.recap }
  }
  return <FocusContextRow {...props} context={complete} resolvePreview={props.list ? resolveListPreview : undefined} />
})
