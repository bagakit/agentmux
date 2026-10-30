import { MoteDialogueViewProvider } from '../lib/mote-dialogue-view'
import { useMoteDefaultConversation } from '../lib/mote-quick-preferences'
import { useMemo, useState, type ReactNode } from 'react'
import { useAppStore } from '../store'
import { MoteWorkfaceContext, useMoteWorkfaceScope } from '../lib/mote-workface'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { useMoteConversationMode } from '../lib/mote-conversation-mode'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'

/** Mote supplies object context; the shared Space owns files and persona tools. */
export function MoteWorkface({ workspaceId, topicId, floating = false, visible = true, recoverOnOpen = visible, reference, conversationEntry, onTabSelect, onReferenceSelect, children }: {
  workspaceId: string; topicId?: string | undefined; floating?: boolean; visible?: boolean; recoverOnOpen?: boolean
  onTabSelect?: ((tabId: string, groupId?: string) => void) | undefined; children: ReactNode
  onReferenceSelect?: ((reference: WorkbenchProjectionSelection) => boolean) | undefined
  reference?: WorkbenchProjectionSelection | null | undefined
  conversationEntry?: number | undefined
}) {
  const scope = useMoteWorkfaceScope(workspaceId, topicId, visible)
  useMoteConversationMode(scope, { workspaceId, topicId, active: visible && recoverOnOpen, floating, reference, conversationEntry })
  const defaults = useMoteDefaultConversation(scope?.topic, scope?.workspace.id ?? workspaceId, visible)
  const owner = JSON.stringify([scope?.workspace.hostId, scope?.workspace.id, scope?.workspace.path, scope?.topic.id, scope?.rootPath])
  const [original, setOriginal] = useState<string | null>(null)
  const presentation: 'workface' | 'conversation' = original === owner ? 'workface' : 'conversation'
  const context = useMemo(() => scope ? { ...scope, floating, defaultConversation: defaults.conversation,
    presentation, showOriginalWorkface: () => setOriginal(owner), showConversation: () => setOriginal(null),
    selectReference: (next: WorkbenchProjectionSelection) => {
      if (onReferenceSelect) return onReferenceSelect(next)
      const state = useAppStore.getState()
      return state.selectMainRegion(next, state.workbenchSpaceSelection)
    },
    selectTab: (tabId: string, groupId: string) => onTabSelect ? onTabSelect(tabId, groupId) : useAppStore.getState().activateTab(workspaceId, groupId, tabId, 'local')
  } : null, [scope, floating, onTabSelect, onReferenceSelect, workspaceId, defaults.conversation, owner, presentation])
  const issue = scope?.issue ?? defaults.issue
  const notice = issue ? <ServiceWindowNotice disclosure={{ scope: JSON.stringify(['mote-context', scope?.workspace.hostId, workspaceId, topicId ?? scope?.topic.id]), id: 'mote-context', occurrence: issue, cause: 'mote-context-observation', visible }} notice={{ kind: 'indeterminate', notice: {
    step: 'Mote context read incomplete', mode: issue, restore: 'Retry this Mote context. Its original Agents and drafts remain available.' } }} /> : null
  if (!floating) return <MoteDialogueViewProvider scope={scope} active={visible}><MoteWorkfaceContext.Provider value={context}><div className="workbench-context-frame" data-mote-workface-presentation={scope ? presentation : undefined}>{notice}{children}</div></MoteWorkfaceContext.Provider></MoteDialogueViewProvider>
  return <MoteDialogueViewProvider scope={scope} active={visible}><MoteWorkfaceContext.Provider value={context}>
    <div className="mote-workface" data-mote-workface={scope?.topic.id} data-mote-workface-presentation={scope ? presentation : undefined}>
      {notice}
      <div className="mote-workface__body">
        <div className="mote-workface__original">{children}</div>
      </div>
    </div>
  </MoteWorkfaceContext.Provider></MoteDialogueViewProvider>
}
