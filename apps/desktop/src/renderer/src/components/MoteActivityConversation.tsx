import { useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { MoteConversationThreads, type MoteWorkReader } from '@agentmux/client-ui/components/MoteConversationThreads'
import type { ConversationRecordInsertion } from '@agentmux/client-ui/components/ConversationRecordSequence'
import type { ConversationReadingGeometry } from '@agentmux/client-ui/conversation-body-work'
import type { DescribeSpeaker } from '@agentmux/client-ui/conversation-speaker'
import type { ConversationRecord } from '@agentmux/client-ui/conversation-records'
import type { MoteDialogueLink } from '@agentmux/core/mote-dialogue'
import { MoteWorkfaceContext } from '../lib/mote-workface'
import { useMoteDialogueView } from '../lib/mote-dialogue-view'
import { api } from '../lib/api'
import { useAppStore } from '../store'
import { workbenchNavigationTabs } from '../lib/workbench-navigation-catalog'
import { workbenchSelectionCatalog } from '../lib/desktop-focus-navigation'
import { moteMembers } from '../lib/mote-team'
import { sameWorkbenchProjectionSelection, type WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { showMoteConversation } from '../lib/mote-conversation-mode'
import { DocumentOverlayPortal } from './WindowOverlayHost'

type Work = Extract<MoteDialogueLink, { kind: 'work' }>
/** Only a presentation of the original Mote, readers and exact navigation targets. */
export function MoteActivityConversation({ sessionId, executionHostId, visible, enabled, records, sourceRevision, geometry, describeSpeaker, renderCurrent }: {
  sessionId: string; executionHostId: string | undefined; visible: boolean; enabled: boolean; records: readonly ConversationRecord[]
  sourceRevision: string; geometry?: ConversationReadingGeometry; describeSpeaker?: DescribeSpeaker; renderCurrent(insertions: readonly ConversationRecordInsertion[]): ReactNode
}) {
  const scope = useContext(MoteWorkfaceContext), view = useMoteDialogueView()
  const facts = useAppStore(useShallow(state => ({ config: state.config, tabs: workbenchNavigationTabs(state.tabs), layouts: state.layouts,
    spaceZoneBindings: state.spaceZoneBindings, topicCategories: state.topicCategories, projectGroups: state.projectGroups,
    scratchTopicSnapshots: state.scratchTopicSnapshots })))
  const graph = useMemo(() => workbenchSelectionCatalog(useAppStore.getState()), [facts])
  const members = useMemo(() => view?.target ? moteMembers(graph, view.target.spaceId) : [], [graph, view?.target?.spaceId])
  const [navigationIssue, setNavigationIssue] = useState('')
  const [locations, setLocations] = useState<WorkbenchProjectionSelection[]>([])
  const identity = JSON.stringify([view?.target, sessionId, executionHostId])
  useEffect(() => { setNavigationIssue(''); setLocations([]) }, [identity])
  // Native output chunks do not cause metadata rereads. Only original captured
  // notices / native semantic transitions invalidate this related Mote projection.
  useEffect(() => { if (visible && enabled && view) view.refresh() }, [visible, enabled, sourceRevision])
  const readWork = useCallback<MoteWorkReader>(async source => {
    const value = await api.sessions.dispatch({ hostId: source.origin.hostId, agentSessionId: source.main.agentSessionId }, source.origin.messageId)
    if (value.hostId !== source.origin.hostId) throw new Error('The work reply belongs to another Host. Original references are retained.')
    return value
  }, [])
  const name = useCallback((source: Work) => {
    const member = members.find(member => member.hostId === source.origin.hostId && member.agentSessionId === source.origin.recipientSessionId)
    return member?.regions.find(region => region.title)?.title ?? source.origin.recipientSessionId
  }, [members])
  function open(reference: WorkbenchProjectionSelection) {
    if (!scope || !view?.target) return
    const current = moteMembers(workbenchSelectionCatalog(useAppStore.getState()), view.target.spaceId)
    if (!current.some(member => member.locations.some(location => sameWorkbenchProjectionSelection(location, reference)))) {
      setNavigationIssue('原工作面位置暂未确认。原 thread、对话和草稿已保留；从团队入口重读原位置。'); return
    }
    if (scope.selectReference(reference)) { setNavigationIssue(''); setLocations([]); showMoteConversation(scope, { reference }) }
    else setNavigationIssue('未能选择这个原位置。当前对话与草稿已保留。')
  }
  function openWork(source: Work) {
    const member = members.find(member => member.hostId === source.origin.hostId && member.agentSessionId === source.origin.recipientSessionId)
    if (member?.locations.length === 1) open(member.locations[0]!)
    else if (member?.locations.length) setLocations([...member.locations])
    else setNavigationIssue('原执行成员的位置暂未确认。原 thread 和当前对话仍可读；从团队入口重读原工作面。')
  }
  function returnMain() {
    const main = view?.page?.main.current
    if (main) open({ displayWorkspaceId: main.displayWorkspaceId, groupId: main.groupId, tabId: main.tabId, regionId: main.regionId })
  }
  if (!enabled || !scope || !view || !executionHostId) return renderCurrent([])
  return <>
    {navigationIssue ? <p role="status" className="mote-conversation__issue">{navigationIssue}</p> : null}
    <MoteConversationThreads page={view.page} issue={view.issue} loading={view.loading} mainUnavailable={view.unavailable} actor={{ hostId: executionHostId, agentSessionId: sessionId }}
      name={scope.topic.title} visible={visible} records={records} conversationClient={api.conversation} readWork={readWork} memberName={name}
      onRefresh={view.refresh} onOlder={() => void view.older()} onOpenWork={openWork} onReturnMain={returnMain} renderCurrent={renderCurrent}
      {...(geometry ? { readingGeometry: geometry } : {})} {...(describeSpeaker ? { describeSpeaker } : {})} />
    {locations.length ? <Dialog.Root open onOpenChange={open => { if (!open) setLocations([]) }}><DocumentOverlayPortal component={Dialog.Portal}>
      <Dialog.Overlay className="dialog-scrim" />
      <Dialog.Content className="dialog-surface" aria-describedby={undefined}><Dialog.Title>选择原工作面位置</Dialog.Title>
        {locations.map((location, index) => <button type="button" className="small-button" key={JSON.stringify(location)} onClick={() => open(location)}>位置 {index + 1} · {location.displayWorkspaceId} / {location.groupId}</button>)}
        <Dialog.Close type="button" className="small-button">取消</Dialog.Close>
      </Dialog.Content>
    </DocumentOverlayPortal></Dialog.Root> : null}
  </>
}
