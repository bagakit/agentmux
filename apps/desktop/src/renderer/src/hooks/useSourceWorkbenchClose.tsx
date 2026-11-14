import { useEffect, useRef, useState } from 'react'
import { mintObjectId } from '@agentmux/core/object-id'
import { spaceCloseDecisions, type SpaceClosePrepare, type SpaceCloseReceipt } from '@agentmux/core/space-close'
import type { SourceWorkbenchCloseDestination, SourceWorkbenchCloseLocations, SourceWorkbenchCloseMember } from '../../../shared/source-workbench-close'
import { sourceWorkbenchCloseMemberMatches } from '../../../shared/source-workbench-close'
import { api } from '../lib/api'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { useAppStore } from '../store'
import { preparedCloseConfirmation, lastViewCloseCopy } from '../lib/last-view-close-confirmation'
import { ConfirmationDialog } from '../components/ConfirmationDialog'
import { SelectionField } from '../components/SelectionField'
import { sourceWorkbenchCloseReference } from '../lib/source-workbench-close'

type Pending = {
  destination: SourceWorkbenchCloseDestination; member: SourceWorkbenchCloseMember; subject: string
  choices: SourceWorkbenchCloseLocations; selected: string
  request?: SpaceClosePrepare; record?: SpaceCloseReceipt; issue?: string | undefined
  applied?: boolean; submitted?: boolean; reviewRequired?: boolean
}
const choiceKey = (location: SourceWorkbenchCloseLocations['locations'][number]) => JSON.stringify(location)

/** Transient review only. The original Source Main owns every plan and effect. */
export function useSourceWorkbenchClose() {
  const [pending, setPending] = useState<Pending | null>(null), [busy, setBusyState] = useState(false)
  const current = useRef<Pending | null>(null), resolve = useRef<((applied: boolean) => void) | null>(null)
  const running = useRef(false)
  const setBusy = (value: boolean) => { running.current = value; setBusyState(value) }
  useEffect(() => () => { const done = resolve.current; resolve.current = null; done?.(false) }, [])
  const update = (value: Pending | null) => { current.current = value; setPending(value) }
  const finish = (applied: boolean) => { update(null); const done = resolve.current; resolve.current = null; done?.(applied) }
  function failed(value: Pending, error: unknown) {
    const issue = error instanceof Error ? error.message : String(error)
    update({ ...value, issue, reviewRequired: Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'SOURCE_CLOSE_REVIEW_REQUIRED') })
    useAppStore.getState().reportError(new Error(`Original close ${value.request?.operationId ?? 'position lookup'} on ${value.destination.hostId}: ${issue}. Keep the original operation; no close was replayed.`), { kind: 'indeterminate' })
  }
  function accept(value: Pending, record: SpaceCloseReceipt): void {
    const target = value.request?.target, actual = record.plan.target
    if (!target || record.operationId !== value.request?.operationId || !sourceWorkbenchCloseMemberMatches(record, value.member) ||
      target.kind !== actual.kind || target.displayWorkspaceId !== actual.displayWorkspaceId || target.groupId !== actual.groupId || target.tabId !== actual.tabId ||
      target.kind === 'region' && (actual.kind !== 'region' || target.regionId !== actual.regionId))
      throw Object.assign(Error('This original plan contains a changed member or position. Its operation is retained. Return to the workface and close its current position.'), { code: 'SOURCE_CLOSE_REVIEW_REQUIRED' })
  }
  async function prepare(value: Pending) {
    const location = value.choices.locations.find(location => choiceKey(location) === value.selected)
    if (!location) return
    const target = value.choices.kind === 'region' ? { kind: 'region' as const, ...location }
      : { kind: 'tab-occurrence' as const, displayWorkspaceId: location.displayWorkspaceId, groupId: location.groupId, tabId: location.tabId }
    const attempt = { ...value, request: { operationId: mintObjectId(), target, keepAgentSessions: true }, issue: undefined }
    update(attempt); setBusy(true)
    try {
      const { operation } = await api.spaceMounts.call('close', { ...attempt.destination, method: 'space.close.prepare', request: attempt.request, member: attempt.member })
      if (!operation) throw Error('The original owner returned no close plan.')
      accept(attempt, operation)
      update({ ...attempt, record: operation })
    } catch (error) { failed(attempt, error) }
    finally { setBusy(false) }
  }
  async function request(reference: WorkbenchProjectionSelection, scope: 'tab' | 'region', subject: string): Promise<boolean> {
    if (resolve.current) return false
    let original: ReturnType<typeof sourceWorkbenchCloseReference>
    try { original = sourceWorkbenchCloseReference(useAppStore.getState(), reference, scope) }
    catch (error) { useAppStore.getState().reportError(error); return false }
    if (!original) return false
    const { destination, member } = original
    const completed = new Promise<boolean>(done => { resolve.current = done })
    const initial: Pending = { destination, member, subject, choices: { kind: 'tab-occurrence', locations: [] }, selected: '' }
    update(initial); setBusy(true)
    try {
      const choices = await api.spaceMounts.call('closeLocations', { ...destination, member })
      if (!choices.locations.length) throw Error('The original workface has no confirmed display position. Open its original Desktop and inspect this same Source; its member and inputs are retained.')
      const value = { ...initial, choices, selected: choices.locations.length === 1 ? choiceKey(choices.locations[0]!) : '' }
      update(value)
      if (choices.locations.length === 1) await prepare(value)
    } catch (error) { failed(initial, error) }
    finally { setBusy(false) }
    return await completed
  }
  async function confirm() {
    const value = current.current
    if (!value || running.current) return
    if (value.applied) { finish(true); return }
    if (value.reviewRequired) { finish(false); return }
    if (!value.request) { if (value.selected) await prepare(value); return }
    setBusy(true)
    try {
      const record = value.record
      const { operation } = !value.submitted && record?.phase === 'prepared' && record.diskDurability === 'confirmed'
        ? await (async () => {
          update({ ...value, submitted: true })
          return await api.spaceMounts.call('close', { ...value.destination, method: 'space.close.apply', request: { operationId: record.operationId, expectedPlanDigest: record.planDigest, decisions: spaceCloseDecisions(record.plan) } })
        })()
        : await api.spaceMounts.call('close', { ...value.destination, method: 'space.close.inspect', request: { operationId: value.request.operationId } })
      if (!operation) throw Error('The original close operation is not yet confirmed. Keep this same operation and check its original owner.')
      accept(value, operation)
      update({ ...value, submitted: operation.phase !== 'prepared', record: operation, applied: operation.outcome === 'applied' && operation.diskDurability === 'confirmed', issue: operation.issue })
    } catch (error) { failed({ ...value, submitted: true }, error) }
    finally { setBusy(false) }
  }
  // Original receipt IDs live in the original Desktop namespace. Do not borrow
  // same-SID local names, Session facts or drafts for its human confirmation.
  const confirmation = pending?.record ? preparedCloseConfirmation(pending.record, { sessions: [], timelines: {}, agentNames: {} }) : null
  const copy = confirmation ? lastViewCloseCopy(confirmation, pending?.choices.kind === 'region' ? 'split' : 'tab') : null
  const ready = pending?.record?.phase === 'prepared' && pending.record.diskDurability === 'confirmed' && !pending.submitted
  const choosing = pending && !pending.request && pending.choices.locations.length > 1
  const terminalEffect = ready && pending?.record?.plan.projection.resources.some(resource => resource.kind === 'session' && resource.control.kind === 'terminal')
  const selectedPosition = pending?.choices.locations.find(location => choiceKey(location) === pending.selected)
  const dialog = <ConfirmationDialog open={pending !== null} busy={busy} confirmDisabled={Boolean(choosing && !pending.selected)} intent={choosing || pending?.applied ? 'neutral' : 'danger'}
    title={choosing ? 'Choose the original position' : pending?.applied ? 'Original view closed' : pending?.reviewRequired ? 'Original position changed' : ready ? copy?.title ?? 'Close the original workface?' : pending?.request ? 'Original close status' : 'Original position unavailable'}
    description={pending?.applied ? 'The selected original position was closed. Retained Agent sessions and any other original positions remain available.' : ready ? (copy?.description ?? 'Review and close the selected original workface.') + (terminalEffect ? ' This also stops the original Terminal process shown in this workface.' : '') : pending?.issue ?? (pending?.record ? `Original close is ${pending.record.outcome}. Check its original owner before another close.` : 'Select the exact original display position before closing.')}
    subject={pending?.subject ?? ''} confirmLabel={pending?.applied ? 'Done' : pending?.reviewRequired ? 'Return to workface' : choosing ? 'Review close' : ready ? copy?.confirmLabel ?? 'Close' : pending?.request ? 'Check original status' : 'Done'}
    feedback={choosing ? <SelectionField label="Original position" missingOptionLabel="Choose a position" value={pending.selected} options={pending.choices.locations.map(location => ({ value: choiceKey(location), label: `${location.displayWorkspaceId} · ${location.groupId}`, description: `Tab ${location.tabId} · Region ${location.regionId}` }))} onValueChange={selected => update({ ...pending, selected })} /> : pending?.request ? <>
      {selectedPosition ? <p className="confirmation-dialog__description">Original position: {selectedPosition.displayWorkspaceId} · {selectedPosition.groupId}<br />Tab {selectedPosition.tabId}{pending.choices.kind === 'region' ? ` · Region ${selectedPosition.regionId}` : ''}</p> : null}
      <details className="confirmation-dialog__description"><summary>Operation details</summary><p>{pending.request.operationId}</p></details>
    </> : undefined}
    onCancel={() => { if (!busy) finish(Boolean(pending?.applied)) }} onConfirm={() => void confirm()} />
  return { request, dialog, busy }
}
