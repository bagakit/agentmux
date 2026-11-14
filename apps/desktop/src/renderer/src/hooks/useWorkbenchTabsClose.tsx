import { useEffect, useRef, useState } from 'react'
import type { TabGroup } from '@agentmux/layout'
import { type SpaceCloseReceipt } from '@agentmux/core'
import { useAppStore } from '../store'
import { preparedCloseConfirmation, lastViewCloseCopy, lastViewCloseStops, type LastViewCloseConfirmation } from '../lib/last-view-close-confirmation'
import { samePreparedCloseReview } from '../lib/workbench-close-owner'
import { ConfirmationDialog } from '../components/ConfirmationDialog'
import { useSourceWorkbenchClose } from './useSourceWorkbenchClose'
import { requiresSourceWorkbenchClose } from '../lib/source-workbench-close'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { WorkbenchDocumentContext, type WorkbenchDocument } from '../lib/workbench-document'
import { DesktopClientUiProvider } from '../components/DesktopClientUiProvider'
import { observeWorkbenchDocumentReturn, workbenchDocumentHasPlacement, workbenchDocumentIdentity, workbenchDocuments } from '../lib/workbench-window-registry'
import type { WorkbenchWindowDocument } from '../../../shared/workbench-windows'

export type WorkbenchTabsCloseRequest = { workspaceId: string; group: Pick<TabGroup, 'id' | 'tabOrder'>; tabIds: readonly string[]; subject: string; keepAgentSessions?: boolean }
type CloseRequest = WorkbenchTabsCloseRequest & { regionId?: string }
type Pending = { request: CloseRequest; remaining: string[]; record: SpaceCloseReceipt; keep: SpaceCloseReceipt | null; confirmation: LastViewCloseConfirmation }
/** Each GUI confirmation applies exactly the same durable plan as the public CLI. */
export function useWorkbenchTabsClose() {
  const sourceClose = useSourceWorkbenchClose()
  const [pending, setPending] = useState<Pending | null>(null), [closing, setClosing] = useState(false), running = useRef(false)
  async function advance(request: CloseRequest, ids: readonly string[]): Promise<void> {
    const remaining = [...ids]
    while (remaining.length) {
      const tabId = remaining.shift()!, state = useAppStore.getState()
      if (!state.tabs[tabId] || !state.checkTabClose(request.workspaceId, request.group.id, tabId, request.regionId)) continue
      if (requiresSourceWorkbenchClose(state, tabId, request.regionId)) {
        if (!await sourceClose.request({ displayWorkspaceId: request.workspaceId, groupId: request.group.id, tabId, regionId: request.regionId ?? state.tabs[tabId]!.layout.activeRegionId }, request.regionId ? 'region' : 'tab', request.subject)) return
        continue
      }
      try {
        const target = request.regionId
          ? { kind: 'region' as const, displayWorkspaceId: request.workspaceId, groupId: request.group.id, tabId, regionId: request.regionId }
          : { kind: 'tab-occurrence' as const, displayWorkspaceId: request.workspaceId, groupId: request.group.id, tabId }
        const record = await state.prepareWorkbenchClose({ target, keepAgentSessions: request.keepAgentSessions === true })
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
  async function request(input: CloseRequest): Promise<void> {
    if (running.current || pending) return
    running.current = true; setClosing(true)
    try { await advance(input, input.tabIds.filter(id => input.group.tabOrder.includes(id))) }
    finally { running.current = false; setClosing(false) }
  }
  async function requestRegion(reference: WorkbenchProjectionSelection, subject: string, options?: { keepAgentSessions?: boolean }): Promise<void> {
    const state = useAppStore.getState(), tab = state.tabs[reference.tabId]
    const group = state.layouts[reference.displayWorkspaceId]?.groups.find(group => group.id === reference.groupId && group.tabOrder.includes(reference.tabId))
    if (!group || !tab?.regions[reference.regionId]) {
      state.reportError(new Error('This Region display location changed. Its Agent and inputs are retained; choose its current exact position before closing.')); return
    }
    await request({ workspaceId: reference.displayWorkspaceId, group, tabIds: [reference.tabId], regionId: reference.regionId, subject, ...options })
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
  const copy = pending ? lastViewCloseCopy(pending.confirmation, pending.request.regionId ? 'split' : 'tab') : null
  const busyDraft = pending?.record.plan.projection.surfaces.some(s => s.blocker === 'draft-busy')
  const dialog = <ConfirmationDialog open={pending !== null} title={copy?.title ?? ''}
    description={(copy?.description ?? '') + (busyDraft ? ' Pending save, shared input or composition stays open; only confirmed independent content can close.' : '')}
    subject={pending?.request.subject ?? ''} confirmLabel={copy?.confirmLabel ?? 'Close'}
    {...(copy?.secondaryLabel ? { secondaryLabel: copy.secondaryLabel, onSecondary: () => void confirm(true) } : {})}
    busy={closing} onCancel={() => !closing && setPending(null)} onConfirm={() => void confirm()} />
  return { request, requestRegion, dialog: <>{dialog}{sourceClose.dialog}</>, closing, active: closing || pending !== null }
}

/** Window-level intent consumer: a target need not mount or become the current Work to close. */
export function WorkbenchCloseRequests() {
  const close = useWorkbenchTabsClose()
  const [presentation, setPresentation] = useState<WorkbenchDocument>(() => ({ document, window: workbenchDocumentIdentity(document) }))
  const tabRequest = useAppStore(state => state.closeTabRequest), regionRequest = useAppStore(state => state.closeRegionRequest)
  useEffect(() => observeWorkbenchDocumentReturn((source, destination) => {
    if (source === document || workbenchDocumentHasPlacement(source)) return
    setPresentation(current => current.document === source ? { document: destination, window: workbenchDocumentIdentity(destination) } : current)
  }), [])
  function present(origin: WorkbenchWindowDocument | null | undefined): boolean {
    const target = origin === undefined ? document : origin && workbenchDocuments().find(doc => {
      const identity = workbenchDocumentIdentity(doc)
      return identity?.windowId === origin.windowId && identity.documentGeneration === origin.documentGeneration
    })
    if (!target) {
      useAppStore.getState().reportError(new Error('The original close window is unconfirmed. Its exact close intent, workface and input are retained; request close again from its current window.'))
      return false
    }
    setPresentation({ document: target, window: workbenchDocumentIdentity(target) })
    return true
  }
  useEffect(() => {
    if (close.active) return
    const state = useAppStore.getState()
    if (tabRequest && state.closeTabRequest === tabRequest) {
      if (!present(tabRequest.originWindow)) return
      state.clearCloseTabRequest(tabRequest.nonce)
      const group = state.layouts[tabRequest.workspaceId]?.groups.find(group => group.id === tabRequest.tabGroupId && group.tabOrder.includes(tabRequest.tabId))
      if (!group) { state.reportError(new Error('This Tab display location changed. Its content is retained; choose its current exact position before closing.')); return }
      void close.request({ workspaceId: tabRequest.workspaceId, group, tabIds: [tabRequest.tabId], subject: state.tabs[tabRequest.tabId]?.name ?? 'Workface', ...(tabRequest.keepAgentSessions ? { keepAgentSessions: true } : {}) })
    } else if (regionRequest && state.closeRegionRequest === regionRequest) {
      if (!present(regionRequest.originWindow)) return
      state.clearCloseRegionRequest(regionRequest.nonce)
      const groups = state.layouts[regionRequest.workspaceId]?.groups.filter(group => group.tabOrder.includes(regionRequest.tabId) && (!regionRequest.groupId || group.id === regionRequest.groupId)) ?? []
      if (groups.length !== 1) { state.reportError(new Error('This Region has no single confirmed display occurrence. Its content is retained; choose its exact position before closing.')); return }
      void close.requestRegion({ displayWorkspaceId: regionRequest.workspaceId, groupId: groups[0]!.id, tabId: regionRequest.tabId, regionId: regionRequest.regionId }, state.tabs[regionRequest.tabId]?.name ?? 'Workface', regionRequest.keepAgentSessions ? { keepAgentSessions: true } : undefined)
    }
    // The existing intent and active confirmation, not function identities, drive consumption.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabRequest, regionRequest, close.active])
  return <WorkbenchDocumentContext.Provider value={presentation}><DesktopClientUiProvider document={presentation.document}>{close.dialog}</DesktopClientUiProvider></WorkbenchDocumentContext.Provider>
}
