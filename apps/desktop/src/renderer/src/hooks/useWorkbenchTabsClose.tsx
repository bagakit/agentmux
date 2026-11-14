import { useState } from 'react'
import type { TabGroup } from '@agentmux/layout'
import { useAppStore } from '../store'
import { documentKey, workbenchSurfaces } from '../lib/workbench-tabs'
import { closingWorkbenchTabs } from '../lib/workbench-view-close'
import { lastViewCloseConfirmation, lastViewCloseCopy, lastViewCloseStops, type LastViewCloseConfirmation } from '../lib/last-view-close-confirmation'
import { ConfirmationDialog } from '../components/ConfirmationDialog'

export type WorkbenchTabsCloseRequest = {
  workspaceId: string
  group: Pick<TabGroup, 'id' | 'tabOrder'>
  tabIds: readonly string[]
  subject: string
}

/** Shared human confirmation; the Store still owns the original close transaction. */
export function useWorkbenchTabsClose() {
  const [pending, setPending] = useState<(WorkbenchTabsCloseRequest & { confirmation: LastViewCloseConfirmation }) | null>(null)
  const [closing, setClosing] = useState(false)

  async function closeTabs(request: WorkbenchTabsCloseRequest, keepAgentSessions = false): Promise<boolean> {
    for (const tabId of request.tabIds) {
      if (!await useAppStore.getState().closeTab(request.workspaceId, request.group.id, tabId, { keepAgentSessions })) return false
    }
    return true
  }

  async function request(request: WorkbenchTabsCloseRequest): Promise<void> {
    const state = useAppStore.getState()
    const tabIds = request.tabIds.filter(id => request.group.tabOrder.includes(id) && state.checkTabClose(request.workspaceId, request.group.id, id))
    if (!tabIds.length || closing) return
    const dirtyCount = new Set(tabIds.flatMap(id => {
      const tab = state.tabs[id]
      return tab ? workbenchSurfaces(tab).flatMap(surface => surface.kind === 'file' &&
        state.dirtyDocuments[documentKey(surface.workspaceId, surface.path)] ? [documentKey(surface.workspaceId, surface.path)] : []) : []
    })).size
    const confirmation = lastViewCloseConfirmation({ tabs: state.tabs, sessions: state.sessions,
      timelines: state.timelines, agentNames: state.agentNames, isClosing: closingWorkbenchTabs(tabIds), dirtyCount })
    const target = { ...request, tabIds }
    if (confirmation) { setPending({ ...target, confirmation }); return }
    setClosing(true)
    try { await closeTabs(target) } finally { setClosing(false) }
  }

  async function confirm(keepAgentSessions = false): Promise<void> {
    if (closing || !pending) return
    const original = pending
    if (!keepAgentSessions && lastViewCloseStops(original.confirmation)) setPending(null)
    setClosing(true)
    try { if (await closeTabs(original, keepAgentSessions)) setPending(current => current === original ? null : current) }
    finally { setClosing(false) }
  }

  const copy = pending ? lastViewCloseCopy(pending.confirmation, pending.tabIds.length > 1 ? 'tabs' : 'tab') : null
  const dialog = <ConfirmationDialog open={pending !== null} title={copy?.title ?? ''} description={copy?.description ?? ''}
    subject={pending && pending.tabIds.length > 1 ? [`${pending.tabIds.length} tabs`,
      pending.confirmation.agents.length ? `${pending.confirmation.agents.length} Agent Sessions` : null,
      pending.confirmation.dirtyCount ? `${pending.confirmation.dirtyCount} unsaved` : null].filter(Boolean).join(' · ') : pending?.subject ?? ''}
    confirmLabel={copy?.confirmLabel ?? 'Close'}
    {...(copy?.secondaryLabel ? { secondaryLabel: copy.secondaryLabel, onSecondary: () => void confirm(true) } : {})}
    busy={closing} onCancel={() => !closing && setPending(null)} onConfirm={() => void confirm()} />
  return { request, dialog, closing }
}
