import { useMemo, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useWorkbenchObjectLayout } from '../hooks/useWorkbenchObjectLayout'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import type { WorkbenchTab } from '../lib/workbench-tabs'
import { workbenchTabDisplayName } from '../lib/workbench-tab-presentation'
import { useWorkbenchTabRecord, useWorkbenchTabSessions } from '../lib/workbench-session-subscriptions'
import { useAppStore } from '../store'
import { useSpaceContentPresentation } from '../lib/space-content-presentation'
import { useMoteSpace } from './MoteSpaceFrame'

const Forward = semanticIconComponent('navigation.forward')
const Discussion = semanticIconComponent('object.conversation')

/** A bounded directory of original Tabs, using their existing Group visit order. */
export function MoteDiscussions({ scope, active, limit }: { scope: MoteWorkfaceScope; active: boolean; limit?: number }) {
  const display = useAppStore(state => state.activeWorkspaceId)
  const object = useWorkbenchObjectLayout(display ?? scope.workspace.id, undefined, active)
  const tabs = useAppStore(state => state.tabs)
  const presentation = useSpaceContentPresentation(), space = useMoteSpace()
  const [issue, setIssue] = useState('')
  const layout = object.choice?.topicId === scope.topic.id ? object.layout : null
  const groups = layout?.groups
  const rows = useMemo(() => {
    const ordered = [...groups ?? []].sort((a, b) => Number(b.id === layout?.activeGroupId) - Number(a.id === layout?.activeGroupId))
    return ordered.flatMap(group => {
      const recent = [...group.recentTabIds].reverse().filter(id => group.tabOrder.includes(id))
      const ids = [...recent, ...group.tabOrder.filter(id => !recent.includes(id))]
      return ids.flatMap(id => {
        const tab = tabs[id]
        return tab ? [{ tab, groupId: group.id, groupIndex: groups!.indexOf(group), visited: recent.includes(id) }] : []
      })
    })
  }, [groups, layout?.activeGroupId, tabs])
  const visible = limit ? rows.slice(0, limit) : rows
  const open = (tab: WorkbenchTab, groupId: string) => {
    const state = useAppStore.getState(), choice = state.workbenchSpaceSelection
    const original = state.tabs[tab.id]
    if (!original || !display || choice?.topicId !== scope.topic.id) { setIssue('This original discussion location is not confirmed. Its reference and work are kept.'); return }
    const selected = state.selectMainRegion({ displayWorkspaceId: display, groupId, tabId: tab.id, regionId: original.layout.activeRegionId }, choice)
    if (selected) { setIssue(''); presentation?.collapse() }
    else setIssue('This original discussion location is not confirmed. Its reference and work are kept.')
  }
  return <section className="mote-discussions" aria-label={limit ? 'Recent discussions' : 'Discussions'}>
    <div className="mote-details__section-actions"><h3>{limit ? 'Recent discussions' : 'Discussions'}</h3>
      {limit && space ? <button type="button" className="mote-discussions__all" onClick={() => space.select('discussion')}>View all<Forward size={13} /></button> : null}
    </div>
    {issue || object.issues.length ? <p role="status" className="mote-details__issue">{issue || object.issues.join(' ')}</p> : null}
    {visible.map(({ tab, groupId, groupIndex, visited }) => <MoteDiscussionRow key={groupId + ':' + tab.id} tab={tab}
      selected={object.choice?.tabId === tab.id && object.choice.groupId === groupId}
      detail={groups && groups.length > 1 ? `Pane ${groupIndex + 1}${visited ? ' · Visited' : ''}` : visited ? 'Recently visited' : 'Open discussion'}
      onOpen={() => open(tab, groupId)} />)}
    {layout && !rows.length ? <p className="mote-details__hint">No discussions yet. Start with a question above.</p> : null}
    {!layout && !object.issues.length ? <p className="mote-details__hint">The original discussion directory is not confirmed yet.</p> : null}
  </section>
}

function MoteDiscussionRow({ tab, selected, detail, onOpen }: { tab: WorkbenchTab; selected: boolean; detail: string; onOpen(): void }) {
  const sessions = useWorkbenchTabSessions(tab), names = useWorkbenchTabRecord('agentNames', tab), timelines = useWorkbenchTabRecord('timelines', tab)
  const title = workbenchTabDisplayName(tab, sessions, names, timelines)
  return <button type="button" className="mote-discussions__row" data-mote-discussion={tab.id} aria-current={selected ? 'page' : undefined}
    title={title} aria-label={`Open discussion: ${title}`} onClick={onOpen}>
    <Discussion size={15} /><span><strong>{title}</strong><small>{detail}</small></span><Forward size={13} />
  </button>
}
