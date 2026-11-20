import * as Dialog from '@agentmux/client-ui/components/Modal'
import { Button } from '@agentmux/client-ui/components/Button'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { restoreComposerInput } from '@agentmux/client-ui/composer-semantic-reference'
import { originalInputDeliveryConfirmed } from '@agentmux/client-ui/input-receipt-projection'
import { currentCoreSpatialGraph, useAppStore } from '../store'
import { mainRegionReference, workbenchSelectionCatalog } from '../lib/desktop-focus-navigation'
import { sameWorkbenchProjectionSelection, type WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { localRetainedInputs, type LocalInputTarget, type LocalRetainedInput } from '../lib/local-retained-inputs'
import { useWorkbenchInputArchive } from '../lib/use-workbench-input-archive'
import { archivedInputMatchesSession } from '../lib/workbench-input-archive'
import { useWorkbenchDocument } from '../lib/workbench-document'
import { useWorkbenchDocumentVisibility } from '../lib/workbench-window-registry'

function savedInputReceipt(entry: NonNullable<LocalRetainedInput['entry']>): string {
  const receipt = entry.inputReceipt
  if (receipt && originalInputDeliveryConfirmed(receipt)) {
    switch (receipt.status) {
      case 'terminal-confirmed': return 'Terminal input confirmed'
      case 'launch-carried': return 'Input carried at launch'
      case 'admitted': return 'Input admitted'
    }
  }
  return receipt ? `${receipt.status} · ${receipt.persistence}` : entry.resumeInputReceipt?.state ?? 'Not recorded here'
}

function LocalInput({ input, archived = false, draftPreview = false }: {
  input: LocalRetainedInput; archived?: boolean; draftPreview?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const [open, setOpen] = useState(false)
  const body = open ? restoreComposerInput(input.text, input.entry?.inputImages) : ''
  const source = input.entry?.originalMember?.target
  return <details className="local-input-record" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{draftPreview ? null : <strong>{input.kind === 'draft' ? 'Draft' : 'Queue entry'}</strong>}<span>{input.text.slice(0, 100) || 'Saved image input'}</span>
      {draftPreview ? null : <small>{source?.runtimeId ?? input.target?.hostId ?? 'Association unknown'}</small>}</summary>
    {open ? <>
      <dl className="session-record-details__facts"><div><dt>Original key</dt><dd>{input.key}</dd></div>
        {input.entry ? <><div><dt>Operation</dt><dd>{input.entry.operationId}</dd></div>
          <div><dt>Saved state</dt><dd>{archived ? 'Archived' : input.entry.status}{!archived && input.entry.archived ? ' · retained' : ''}{input.entry.movedToDraft ? ' · moved to draft' : ''}{input.entry.awaitingExplicitSend ? ' · explicit send required' : ''}</dd></div>
          <div><dt>Delivery receipt</dt><dd>{savedInputReceipt(input.entry)}</dd></div></> : null}
        <div><dt>Association</dt><dd>{source ? `Runtime ${source.runtimeId} / ${source.agentSessionId}` : input.target ? `${input.target.hostId} / ${input.target.agentSessionId}` : 'Unknown · original key kept'}</dd></div>
      </dl>
      <textarea aria-label="Original saved input" readOnly value={body} rows={Math.min(8, Math.max(3, body.split('\n').length))} />
      <Button type="button" onClick={() => void copyTextToClipboard(body,
        error => useAppStore.getState().reportError(error, { kind: 'indeterminate', summary: 'Copying the original saved input was not confirmed. Its content and state are kept; retry copying.' })).then(setCopied)}>{copied ? 'Copied' : 'Copy saved input'}</Button>
    </> : null}
  </details>
}

/** Mounted only by an explicit reader. It never edits or re-admits the original intent. */
export function LocalRetainedInputs({ target, onOpenDraft, canOpenDraft }: {
  target?: LocalInputTarget
  onOpenDraft?(key: string): void
  canOpenDraft?: ((key: string) => boolean) | undefined
}) {
  const [drafts, queues, graph] = useAppStore(useShallow(state => [state.agentComposerDrafts, state.agentSteerQueues, currentCoreSpatialGraph()] as const))
  const [limit, setLimit] = useState(30)
  const document = useWorkbenchDocument()
  const archive = useWorkbenchInputArchive(target?.agentSessionId, useWorkbenchDocumentVisibility(document))
  const inputs = useMemo(() => localRetainedInputs(drafts, queues, graph).filter(input => !target ||
    !input.entry?.originalMember && input.target?.hostId === target.hostId && input.target.agentSessionId === target.agentSessionId), [drafts, queues, graph, target?.hostId, target?.agentSessionId])
  const archived = useMemo(() => archive.entries.flatMap(({ ownerKey, entry }): LocalRetainedInput[] => {
    const original = entry.directInputControl
    if (target && !archivedInputMatchesSession(entry, target.hostId, target.agentSessionId) ||
        queues[ownerKey]?.some(known => known.operationId === entry.operationId)) return []
    return [{ kind: 'queue', key: ownerKey, text: entry.text, entry,
      ...(original ? { target: { hostId: original.hostId, agentSessionId: original.agentSessionId } } : {}) }]
  }), [archive.entries, queues, target?.hostId, target?.agentSessionId])
  const preview = inputs.slice(0, limit)
  const inputKey = (input: LocalRetainedInput) => JSON.stringify([input.kind, input.key, input.entry?.operationId])
  const savedQueues = [...preview.filter(input => input.kind === 'queue'), ...archived]
  return <div className="local-retained-inputs" aria-label={target ? 'Local inputs for original Session' : 'All saved local inputs'}>
    {onOpenDraft ? <>
      <div className="focus-draft-list">
        {preview.filter(input => input.kind === 'draft').map(input => <div key={inputKey(input)} className="focus-draft-list__entry">
          <LocalInput input={input} draftPreview />
          {canOpenDraft?.(input.key) ? <Button type="button" onClick={() => onOpenDraft(input.key)}>Continue writing</Button> : null}
        </div>)}
      </div>
      <details className="focus-draft-queues"><summary>Queue records</summary>
        {savedQueues.length ? savedQueues.map(input => <LocalInput key={inputKey(input)} input={input} archived={archived.includes(input)} />) : <p>No saved queue records.</p>}
      </details>
    </> : <>
      {preview.map(input => <LocalInput key={inputKey(input)} input={input} />)}
      {archived.map(input => <LocalInput key={inputKey(input)} input={input} archived />)}
    </>}
    {!inputs.length && !archived.length && !archive.loading && !archive.error && archive.nextCursor === null ? <p>{target ? 'No exactly associated local inputs. All saved inputs are available from Focus actions.' : 'No saved drafts or queue entries in this client.'}</p> : null}
    {inputs.length > limit ? <Button type="button" onClick={() => setLimit(value => value + 30)}>Show more ({inputs.length - limit})</Button> : null}
    {archive.loading ? <p role="status">Reading saved inputs…</p> : null}
    {archive.error ? <div role="status"><p>{archive.error}</p><Button type="button" onClick={() => void archive.refresh()}>Retry saved inputs</Button></div> : null}
    {archive.nextCursor !== null ? <Button type="button" disabled={archive.loading} onClick={archive.loadEarlier}>Load earlier saved inputs</Button> : null}
  </div>
}

export function LocalRetainedInputDetails({ target, visible = true }: { target: LocalInputTarget; visible?: boolean }) {
  const [open, setOpen] = useState(false)
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>Saved local inputs</summary>
    {open && visible ? <LocalRetainedInputs target={target} /> : null}</details>
}

function draftLocations(state: ReturnType<typeof useAppStore.getState>, locations: ReturnType<typeof workbenchSelectionCatalog>['locations']) {
  const exact = new Map<string, WorkbenchProjectionSelection | null>()
  for (const location of locations) {
    const key = location.regionId
    const region = state.tabs[location.tabId]?.regions[key]
    if (state.agentComposerDrafts[key] && (region?.kind === 'agent' || region?.kind === 'launcher'))
      exact.set(key, exact.has(key) ? null : location)
  }
  return exact
}

export function LocalRetainedInputsPanel({ open, onOpenChange, onOpenLocation, onClose }: {
  open: boolean
  onOpenChange(open: boolean): void
  onOpenLocation?: ((reference: WorkbenchProjectionSelection) => boolean | void) | undefined
  onClose(restoreFocus: boolean): void
}) {
  const navigated = useRef(false)
  const [issue, setIssue] = useState<string | null>(null)
  const [catalog, draftTexts] = useAppStore(useShallow(state => open ? [workbenchSelectionCatalog(state), state.agentComposerDrafts] as const : [null, null] as const))
  const availableDrafts = useMemo(() => catalog && draftTexts ? draftLocations(useAppStore.getState(), catalog.locations) : null, [catalog, draftTexts])
  function continueDraft(key: string) {
    const state = useAppStore.getState()
    const reference = draftLocations(state, workbenchSelectionCatalog(state).locations).get(key)
    if (reference && onOpenLocation && onOpenLocation(reference) !== false &&
      sameWorkbenchProjectionSelection(mainRegionReference(useAppStore.getState().workbenchSpaceSelection), reference)) {
      navigated.current = true
      onOpenChange(false)
    } else setIssue('The original input location could not be opened. You can still copy the saved draft.')
  }
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <DocumentOverlayPortal component={Dialog.Portal}>
      <Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
      <Dialog.Content className="dialog-surface session-record-dialog focus-local-inputs" aria-describedby={undefined}
        onPointerDownCapture={event => event.stopPropagation()}
        onCloseAutoFocus={event => {
          event.preventDefault()
          onClose(!navigated.current)
          navigated.current = false
          setIssue(null)
        }}>
        <header><Dialog.Title>Saved inputs</Dialog.Title><Dialog.Close asChild><Button type="button">Close</Button></Dialog.Close></header>
        {issue ? <p role="status">{issue}</p> : null}
        {open ? <LocalRetainedInputs onOpenDraft={continueDraft} canOpenDraft={key => Boolean(onOpenLocation && availableDrafts?.get(key))} /> : null}
      </Dialog.Content>
    </DocumentOverlayPortal>
  </Dialog.Root>
}
