import { useCallback, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { MoteWorkThreads, type MoteWorkReader } from '@agentmux/client-ui/components/MoteConversationThreads'
import { useMoteDialogueView } from '../lib/mote-dialogue-view'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import { moteMembers } from '../lib/mote-team'
import { workbenchSelectionCatalog } from '../lib/desktop-focus-navigation'
import { workbenchNavigationTabs } from '../lib/workbench-navigation-catalog'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { useAppStore } from '../store'
import { api } from '../lib/api'
import { MoteCooperation } from './MoteCooperation'

/** Threads reads original work sources even when the Main native conversation is unavailable. */
export function MoteThreadsPanel({ scope, active, onSelect }: {
  scope: MoteWorkfaceScope; active: boolean; onSelect(reference: WorkbenchProjectionSelection): boolean
}) {
  const dialogue = useMoteDialogueView()
  const facts = useAppStore(useShallow(state => ({ config: state.config, tabs: workbenchNavigationTabs(state.tabs), layouts: state.layouts,
    spaceZoneBindings: state.spaceZoneBindings, topicCategories: state.topicCategories, projectGroups: state.projectGroups,
    scratchTopicSnapshots: state.scratchTopicSnapshots })))
  const members = useMemo(() => dialogue?.target ? moteMembers(workbenchSelectionCatalog(useAppStore.getState()), dialogue.target.spaceId) : [], [facts, dialogue?.target?.spaceId])
  const [issue, setIssue] = useState(''), [locations, setLocations] = useState<WorkbenchProjectionSelection[]>([])
  const readWork = useCallback<MoteWorkReader>(async source => {
    const result = await api.sessions.dispatch({ hostId: source.origin.hostId, agentSessionId: source.main.agentSessionId }, source.origin.messageId)
    if (result.hostId !== source.origin.hostId) throw new Error('工作来源的 Host 未能核对。原引用仍保留。')
    return result
  }, [])
  if (!dialogue) return null
  return <div className="mote-threads-panel" hidden={!active}>
    <MoteWorkThreads page={dialogue.page} issue={dialogue.issue} loading={dialogue.loading} visible={active} readWork={readWork}
      memberName={source => members.find(member => member.hostId === source.origin.hostId && member.agentSessionId === source.origin.recipientSessionId)?.regions.find(region => region.title)?.title ?? source.origin.recipientSessionId}
      onRefresh={dialogue.refresh} onOlder={() => void dialogue.older()} onOpenWork={source => {
        const original = dialogue.target && moteMembers(workbenchSelectionCatalog(useAppStore.getState()), dialogue.target.spaceId)
          .find(member => member.hostId === source.origin.hostId && member.agentSessionId === source.origin.recipientSessionId)
        if (original?.locations.length === 1) onSelect(original.locations[0]!)
        else if (original?.locations.length) setLocations(original.locations)
        else setIssue('这个原执行成员的位置暂未确认。原 thread 仍可读；请重读成员位置。')
      }} />
    {issue ? <p role="status" className="mote-conversation__issue">{issue}</p> : null}
    {locations.length ? <div className="mote-threads-panel__locations" role="group" aria-label="选择原工作位置">
      {locations.map((reference, index) => <button type="button" key={JSON.stringify(reference)} onClick={() => { if (onSelect(reference)) setLocations([]) }}>位置 {index + 1} · {reference.displayWorkspaceId}</button>)}
      <button type="button" onClick={() => setLocations([])}>取消</button>
    </div> : null}
    <MoteCooperation scope={scope} active={active} presentation="threads" onSelect={onSelect} />
  </div>
}
