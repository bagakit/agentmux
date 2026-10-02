import { useMemo, type ReactNode } from 'react'
import { useAppStore } from '../store'
import { MoteWorkfaceContext, useMoteWorkfaceScope } from '../lib/mote-workface'

/** Mote supplies object context; the shared Space owns files and persona tools. */
export function MoteWorkface({ workspaceId, topicId, floating = false, onTabSelect, children }: {
  workspaceId: string; topicId?: string | undefined; floating?: boolean; visible?: boolean
  onTabSelect?: ((tabId: string, groupId?: string) => void) | undefined; children: ReactNode
}) {
  const scope = useMoteWorkfaceScope(workspaceId, topicId)
  const context = useMemo(() => scope ? { ...scope, floating,
    selectTab: (tabId: string, groupId: string) => onTabSelect ? onTabSelect(tabId, groupId) : useAppStore.getState().activateTab(workspaceId, groupId, tabId)
  } : null, [scope, floating, onTabSelect, workspaceId])
  if (!floating) return <MoteWorkfaceContext.Provider value={context}>{children}</MoteWorkfaceContext.Provider>
  return <MoteWorkfaceContext.Provider value={context}>
    <div className="mote-workface" data-mote-workface={scope?.topic.id}>
      <div className="mote-workface__body">
        <div className="mote-workface__original">{children}</div>
      </div>
    </div>
  </MoteWorkfaceContext.Provider>
}
