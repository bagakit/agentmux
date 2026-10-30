import { useWorkbenchBrowserPresentation } from '../lib/workbench-presentation'
import { useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { MoteConversationThreads, type MoteWorkReader } from '@agentmux/client-ui/components/MoteConversationThreads'
import type { ConversationRecordInsertion } from '@agentmux/client-ui/components/ConversationRecordSequence'
import type { ConversationReadingGeometry } from '@agentmux/client-ui/conversation-body-work'
import type { DescribeSpeaker } from '@agentmux/client-ui/conversation-speaker'
import type { ConversationRecord } from '@agentmux/client-ui/conversation-records'
import { MoteWorkfaceContext } from '../lib/mote-workface'
import { useMoteDialogueView } from '../lib/mote-dialogue-view'
import { api } from '../lib/api'
import { useAppStore } from '../store'
import { moteMembers } from '../lib/mote-team'
import { workbenchNavigationTabs } from '../lib/workbench-navigation-catalog'
import { workbenchSelectionCatalog } from '../lib/desktop-focus-navigation'
import { requestPmoTeamsTopicFloatingOpen, requestPmoTeamsTopicFloatingThreads } from '../lib/pmo-teams-topic-floating'

/** Discussion keeps original Main sources. Worker reading belongs to the Threads shell. */
export function MoteActivityConversation({ sessionId, executionHostId, visible, enabled, sourceRevision, geometry, describeSpeaker, renderCurrent }: {
  sessionId: string; executionHostId: string | undefined; visible: boolean; enabled: boolean; records: readonly ConversationRecord[]
  sourceRevision: string; geometry?: ConversationReadingGeometry; describeSpeaker?: DescribeSpeaker; renderCurrent(insertions: readonly ConversationRecordInsertion[]): ReactNode
}) {
  const scope = useContext(MoteWorkfaceContext), view = useMoteDialogueView()
  const presentation = useWorkbenchBrowserPresentation()
  const facts = useAppStore(useShallow(state => ({ config: state.config, tabs: workbenchNavigationTabs(state.tabs), layouts: state.layouts,
    spaceZoneBindings: state.spaceZoneBindings, topicCategories: state.topicCategories, projectGroups: state.projectGroups,
    scratchTopicSnapshots: state.scratchTopicSnapshots })))
  const members = useMemo(() => view?.target ? moteMembers(workbenchSelectionCatalog(useAppStore.getState()), view.target.spaceId) : [], [facts, view?.target?.spaceId])
  const readWork = useCallback<MoteWorkReader>(async source => {
    const value = await api.sessions.dispatch({ hostId: source.origin.hostId, agentSessionId: source.main.agentSessionId }, source.origin.messageId)
    if (value.hostId !== source.origin.hostId) throw new Error('工作来源未能核对，原引用仍保留。')
    return value
  }, [])
  const memberIntent = scope?.memberIntent || presentation.moteInputIntent === 'member'
  const showThreads = presentation.surface === 'mote' && scope
    ? () => { requestPmoTeamsTopicFloatingThreads(scope.topic.id) } : scope?.showThreads
  useEffect(() => { if (visible && enabled && !memberIntent && view) view.refresh() }, [visible, enabled, sourceRevision, memberIntent])
  if (!enabled || !scope || memberIntent || !view || !executionHostId) return renderCurrent([])
  return <MoteConversationThreads page={view.page} issue={view.issue} actor={{ hostId: executionHostId, agentSessionId: sessionId }}
    name={scope.topic.title} visible={visible} conversationClient={api.conversation}
    work={{ readWork, memberName: source => members.find(member => member.hostId === source.origin.hostId && member.agentSessionId === source.origin.recipientSessionId)?.regions.find(region => region.title)?.title ?? '执行者未确认',
      ...(showThreads ? { onShowThreads: showThreads } : {}),
      onOpenWork: source => {
        const member = members.find(member => member.hostId === source.origin.hostId && member.agentSessionId === source.origin.recipientSessionId)
        if (member?.locations.length === 1) {
          if (presentation.surface === 'mote') requestPmoTeamsTopicFloatingOpen({ targetTopicId: scope.topic.id, reference: member.locations[0]! })
          else scope.showThread?.(member.locations[0]!)
        } else showThreads?.()
      } }}
    onOlder={() => void view.older()} renderCurrent={renderCurrent}
    {...(geometry ? { readingGeometry: geometry } : {})} {...(describeSpeaker ? { describeSpeaker } : {})} />
}
