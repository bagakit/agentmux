import { useMemo, type ReactNode } from 'react'
import { useAppStore } from '../store'
import { MoteWorkfaceContext, useMoteWorkfaceScope } from '../lib/mote-workface'
import { ServiceWindowNotice } from './ServiceWindowNotice'

/** Mote supplies object context; the shared Space owns files and persona tools. */
export function MoteWorkface({ workspaceId, topicId, floating = false, visible = true, onTabSelect, children }: {
  workspaceId: string; topicId?: string | undefined; floating?: boolean; visible?: boolean
  onTabSelect?: ((tabId: string, groupId?: string) => void) | undefined; children: ReactNode
}) {
  const scope = useMoteWorkfaceScope(workspaceId, topicId, visible)
  const context = useMemo(() => scope ? { ...scope, floating,
    selectTab: (tabId: string, groupId: string) => onTabSelect ? onTabSelect(tabId, groupId) : useAppStore.getState().activateTab(workspaceId, groupId, tabId, 'local')
  } : null, [scope, floating, onTabSelect, workspaceId])
  const notice = scope?.issue ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: {
    step: 'Mote directory unconfirmed', mode: scope.issue, restore: 'Retry this Mote directory. Its original Agents and drafts remain available.' } }} /> : null
  if (!floating) return <MoteWorkfaceContext.Provider value={context}>{notice}{children}</MoteWorkfaceContext.Provider>
  return <MoteWorkfaceContext.Provider value={context}>
    <div className="mote-workface" data-mote-workface={scope?.topic.id}>
      {notice}
      <div className="mote-workface__body">
        <div className="mote-workface__original">{children}</div>
      </div>
    </div>
  </MoteWorkfaceContext.Provider>
}
