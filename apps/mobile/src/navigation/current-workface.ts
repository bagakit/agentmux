import type { MobilePresentationRoute, MobileTopicSourceReference } from '../recovery/presentation-route'

/** A view of the original navigation, not another route or persistent record. */
export function currentMobileWorkface(input: {
  primary: MobilePresentationRoute['primary']; showSession: boolean; showGoalWork: boolean
  panel: 'conversation' | 'terminal'; mote: boolean; section: 'discussion' | 'threads'; threadDetail: boolean
  sourceKind: MobileTopicSourceReference['kind'] | undefined
}) {
  const { primary, showSession, showGoalWork, panel } = input
  const moteConversation = showSession && primary === 'mote' && input.mote
  const thread = moteConversation && input.threadDetail
  const source = !showSession && primary === 'topics' && input.sourceKind !== undefined
  const sourceReader = source && (input.sourceKind === 'file' || input.sourceKind === 'note' || input.sourceKind === 'notebook')
  const kind = !showSession ? source ? 'source' : 'directory'
    : showGoalWork ? 'goal' : panel === 'terminal' ? 'terminal'
    : thread ? 'thread' : moteConversation && input.section === 'threads' ? 'threads' : 'conversation'
  const workPanel = kind === 'goal' || kind === 'terminal'
  const moteRoot = moteConversation && !thread && !workPanel
  const sessionDepth = thread ? 2 : 1
  return {
    // Keep the validated route fields separate from the current pane geometry.
    route: { primary, showSession, showGoalWork }, kind, source, sourceReader, moteConversation, moteRoot, workPanel,
    directory: showSession ? null : primary, session: showSession, goal: kind === 'goal', terminal: kind === 'terminal',
    conversation: kind === 'conversation' || kind === 'thread', threads: kind === 'threads',
    root: !showSession || moteRoot,
    // Feature navigation owns its inner transitions; it does not push the whole directory.
    motionLayer: !showSession ? `directory:${primary}` : kind === 'threads' ? 'conversation' : kind,
    depth: !showSession ? 0 : workPanel ? sessionDepth + 1 : sessionDepth,
    inlineHeader: !showSession && (!source || sourceReader),
  }
}
