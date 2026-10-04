import { useMoteDefaultConversation } from '../lib/mote-quick-preferences'
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
  const defaults = useMoteDefaultConversation(scope?.topic, scope?.workspace.id ?? workspaceId, visible)
  const context = useMemo(() => scope ? { ...scope, floating, defaultConversation: defaults.conversation,
    selectTab: (tabId: string, groupId: string) => onTabSelect ? onTabSelect(tabId, groupId) : useAppStore.getState().activateTab(workspaceId, groupId, tabId, 'local')
  } : null, [scope, floating, onTabSelect, workspaceId, defaults.conversation])
  const issue = scope?.issue ?? defaults.issue
  const notice = issue ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: {
    step: 'Mote context read incomplete', mode: issue, restore: 'Retry this Mote context. Its original Agents and drafts remain available.' } }} /> : null
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
