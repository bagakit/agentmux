import { useRef, useState } from 'react'
import type { TabGroup } from '@agentmux/layout'
import { type SpaceCloseReceipt } from '@agentmux/core'
import { useAppStore } from '../store'
import { preparedCloseConfirmation, lastViewCloseCopy, lastViewCloseStops, type LastViewCloseConfirmation } from '../lib/last-view-close-confirmation'
import { samePreparedCloseReview } from '../lib/workbench-close-owner'
import { ConfirmationDialog } from '../components/ConfirmationDialog'

export type WorkbenchTabsCloseRequest = { workspaceId: string; group: Pick<TabGroup, 'id' | 'tabOrder'>; tabIds: readonly string[]; subject: string }
type Pending = { request: WorkbenchTabsCloseRequest; remaining: string[]; record: SpaceCloseReceipt; keep: SpaceCloseReceipt | null; confirmation: LastViewCloseConfirmation }
/** Each GUI confirmation applies exactly the same durable plan as the public CLI. */
export function useWorkbenchTabsClose() {
  const [pending, setPending] = useState<Pending | null>(null), [closing, setClosing] = useState(false), running = useRef(false)
  async function advance(request: WorkbenchTabsCloseRequest, ids: readonly string[]): Promise<void> {
    const remaining = [...ids]
    while (remaining.length) {
      const tabId = remaining.shift()!, state = useAppStore.getState()
      if (!state.tabs[tabId] || !state.checkTabClose(request.workspaceId, request.group.id, tabId)) continue
      try {
        const record = await state.prepareWorkbenchClose({ target: { kind: 'tab-occurrence', displayWorkspaceId: request.workspaceId, groupId: request.group.id, tabId }, keepAgentSessions: false })
        const confirmation = preparedCloseConfirmation(record, useAppStore.getState())
        if (confirmation) {
          const keep = lastViewCloseStops(confirmation) ? await state.prepareWorkbenchClose({ target: record.plan.target, keepAgentSessions: true }) : null
          // Preparing the alternate Keep decision cannot silently approve intervening draft input.
          if (keep && !samePreparedCloseReview(record, keep)) throw new Error('The draft changed while preparing the close choices. Review the current workface and close it again.')
          setPending({ request, remaining, record, keep, confirmation }); return
        }
        await state.applyWorkbenchClose(record)
      } catch (error) { useAppStore.getState().reportError(error) }
    }
  }
  async function request(input: WorkbenchTabsCloseRequest): Promise<void> {
    if (running.current || pending) return
    running.current = true; setClosing(true)
    try { await advance(input, input.tabIds.filter(id => input.group.tabOrder.includes(id))) }
    finally { running.current = false; setClosing(false) }
  }
  async function confirm(keepAgentSessions = false): Promise<void> {
    if (running.current || !pending) return
    const original = pending, record = keepAgentSessions ? original.keep : original.record
    if (!record) return
    setPending(null); running.current = true; setClosing(true)
    try { await useAppStore.getState().applyWorkbenchClose(record); await advance(original.request, original.remaining) }
    catch (error) { useAppStore.getState().reportError(error) }
    finally { running.current = false; setClosing(false) }
  }
  const copy = pending ? lastViewCloseCopy(pending.confirmation, 'tab') : null
  const busyDraft = pending?.record.plan.projection.surfaces.some(s => s.blocker === 'draft-busy')
  const dialog = <ConfirmationDialog open={pending !== null} title={copy?.title ?? ''}
    description={(copy?.description ?? '') + (busyDraft ? ' Pending save, shared input or composition stays open; only confirmed independent content can close.' : '')}
    subject={pending ? pending.record.plan.target.tabId : ''} confirmLabel={copy?.confirmLabel ?? 'Close'}
    {...(copy?.secondaryLabel ? { secondaryLabel: copy.secondaryLabel, onSecondary: () => void confirm(true) } : {})}
    busy={closing} onCancel={() => !closing && setPending(null)} onConfirm={() => void confirm()} />
  return { request, dialog, closing }
}
