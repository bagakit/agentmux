import * as Dialog from '@agentmux/client-ui/components/Modal'
import { Button } from '@agentmux/client-ui/components/Button'
import { IconButton } from '@agentmux/client-ui/components/IconButton'
import { SearchInput } from '@agentmux/client-ui/input'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { parseComposerDraft, restoreComposerInput, selectedImageReference } from '@agentmux/client-ui/composer-semantic-reference'
import { splitPastedImageReferences } from '@agentmux/client-ui/pasted-image-reference'
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

const CloseIcon = semanticIconComponent('action.close')
const CopyIcon = semanticIconComponent('action.copy')
const ConfirmIcon = semanticIconComponent('action.confirm')
const AttachmentIcon = semanticIconComponent('object.file')
const DisclosureIcon = semanticIconComponent('navigation.disclosure')
const ContinueIcon = semanticIconComponent('navigation.forward')

function localInputPresentation(text: string) {
  const prose: string[] = [], attachments = new Set<string>()
  const collectText = (value: string) => {
    for (const segment of splitPastedImageReferences(value)) {
      if (segment.kind === 'text') prose.push(segment.text)
      else attachments.add(segment.path.split(/[\\/]/).at(-1) ?? segment.path)
    }
  }
  for (const part of parseComposerDraft(text)) {
    if ('text' in part) collectText(part.text)
    else {
      const image = selectedImageReference(part.reference)
      attachments.add(image?.upload.name ?? part.reference.label)
    }
  }
  const normalized = prose.join(' ').replace(/\s+/gu, ' ').trim()
  const excerpt = normalized.length > 220 ? normalized.slice(0, 220) + '…' : normalized
  return {
    excerpt: excerpt || (attachments.size ? [...attachments].join(' · ') : 'Saved input'),
    attachments: normalized ? [...attachments] : [],
    searchText: `${text}\n${normalized}\n${[...attachments].join('\n')}`.toLocaleLowerCase(),
  }
}

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

function LocalInput({ input, archived = false }: { input: LocalRetainedInput; archived?: boolean }) {
  const [copied, setCopied] = useState(false)
  const [open, setOpen] = useState(false)
  const body = open ? restoreComposerInput(input.text, input.entry?.inputImages) : ''
  const source = input.entry?.originalMember?.target
  const presentation = useMemo(() => localInputPresentation(input.text), [input.text])
  return <details className="local-input-record" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><span className="local-input-record__excerpt">{presentation.excerpt}</span>
      <span className="local-input-record__meta"><span>{input.kind === 'draft' ? 'Draft' : archived ? 'Archived' : 'Queued'}</span>
        {presentation.attachments.slice(0, 2).map(name => <span className="local-input-record__attachment" key={name} title={name}><AttachmentIcon size={11} aria-hidden="true" />{name}</span>)}
        {presentation.attachments.length > 2 ? <span>+{presentation.attachments.length - 2}</span> : null}</span>
      <DisclosureIcon className="local-input-record__chevron" size={13} aria-hidden="true" /></summary>
    {open ? <div className="local-input-record__expanded">
      <textarea aria-label="Original saved input" readOnly value={body} rows={Math.min(8, Math.max(3, body.split('\n').length))} />
      <div className="local-input-record__actions"><Button type="button" onClick={() => void copyTextToClipboard(body,
        error => useAppStore.getState().reportError(error, { kind: 'indeterminate', summary: 'Copying the original saved input was not confirmed. Its content and state are kept; retry copying.' })).then(setCopied)}>
        {copied ? <ConfirmIcon size={12} aria-hidden="true" /> : <CopyIcon size={12} aria-hidden="true" />}{copied ? 'Copied' : 'Copy saved input'}</Button></div>
      <details className="local-input-record__diagnostics"><summary>Storage &amp; delivery details<DisclosureIcon size={12} aria-hidden="true" /></summary>
        <dl className="session-record-details__facts"><div><dt>Original key</dt><dd>{input.key}</dd></div>
          {input.entry ? <><div><dt>Operation</dt><dd>{input.entry.operationId}</dd></div>
            <div><dt>Saved state</dt><dd>{archived ? 'Archived' : input.entry.status}{!archived && input.entry.archived ? ' · retained' : ''}{input.entry.movedToDraft ? ' · moved to draft' : ''}{input.entry.awaitingExplicitSend ? ' · explicit send required' : ''}</dd></div>
            <div><dt>Delivery receipt</dt><dd>{savedInputReceipt(input.entry)}</dd></div></> : null}
          <div><dt>Association</dt><dd>{source ? `Runtime ${source.runtimeId} / ${source.agentSessionId}` : input.target ? `${input.target.hostId} / ${input.target.agentSessionId}` : 'Unknown · original key kept'}</dd></div>
        </dl>
      </details>
    </div> : null}
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
  const [query, setQuery] = useState('')
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
  const search = query.trim().toLocaleLowerCase()
  const matches = (input: LocalRetainedInput) => !search || localInputPresentation(input.text).searchText.includes(search)
  const matchingInputs = useMemo(() => inputs.filter(matches), [inputs, search])
  const matchingArchived = useMemo(() => archived.filter(matches), [archived, search])
  const preview = matchingInputs.slice(0, limit)
  const inputKey = (input: LocalRetainedInput) => JSON.stringify([input.kind, input.key, input.entry?.operationId])
  const savedQueues = [...preview.filter(input => input.kind === 'queue'), ...matchingArchived]
  const visibleDrafts = preview.filter(input => input.kind === 'draft')
  const scopedInputs = [...preview, ...matchingArchived]
  const matchCount = matchingInputs.length + matchingArchived.length
  const noMatches = Boolean(search) && !matchCount && !archive.loading
  const remaining = Math.max(0, matchingInputs.length - limit)
  return <div className="local-retained-inputs" aria-label={target ? 'Local inputs for original Session' : 'All saved local inputs'}>
    <SearchInput className="local-retained-inputs__search" aria-label="Search saved inputs" clearLabel="Clear saved input search"
      placeholder="Search saved inputs…" value={query} onValueChange={setQuery} />
    {search || archive.nextCursor !== null ? <p className="local-retained-inputs__coverage" role="status">{search ? `${matchCount} matching loaded inputs` : 'Search covers loaded inputs'}{archive.nextCursor !== null ? ' · earlier inputs available' : ''}</p> : null}
    {onOpenDraft ? <>
      {visibleDrafts.length ? <section className="focus-draft-section" aria-label="Saved drafts"><header><span>Drafts</span><span>{visibleDrafts.length}</span></header>
        <div className="focus-draft-list">
          {visibleDrafts.map(input => <div key={inputKey(input)} className="focus-draft-list__entry">
            <LocalInput input={input} />
            {canOpenDraft?.(input.key) ? <Button className="focus-draft-list__continue" type="button" onClick={() => onOpenDraft(input.key)}>Continue writing<ContinueIcon size={12} aria-hidden="true" /></Button> : null}
          </div>)}
        </div></section> : null}
      {savedQueues.length ? <details className="focus-draft-queues" open={search ? true : undefined}><summary><span>Queued &amp; archived</span><span>{savedQueues.length}</span><DisclosureIcon size={13} aria-hidden="true" /></summary>
        <div className="focus-draft-queues__records">{savedQueues.map(input => <LocalInput key={inputKey(input)} input={input} archived={matchingArchived.includes(input)} />)}</div>
      </details> : null}
    </> : <>
      {scopedInputs.map(input => <LocalInput key={inputKey(input)} input={input} archived={matchingArchived.includes(input)} />)}
    </>}
    {noMatches ? <p className="local-retained-inputs__empty">No matches in loaded inputs.{archive.nextCursor !== null ? ' Load earlier inputs to search more.' : ''}</p> : null}
    {!search && !inputs.length && !archived.length && !archive.loading && !archive.error && archive.nextCursor === null ? <p className="local-retained-inputs__empty">{target ? 'No exactly associated local inputs. All saved inputs are available from Focus actions.' : 'No saved drafts or queue entries in this client.'}</p> : null}
    {archive.loading ? <p role="status">Reading saved inputs…</p> : null}
    {archive.error ? <div role="status"><p>{archive.error}</p><Button type="button" onClick={() => void archive.refresh()}>Retry saved inputs</Button></div> : null}
    {remaining || archive.nextCursor !== null ? <div className="local-retained-inputs__pagination">
      {remaining ? <Button type="button" onClick={() => setLimit(value => value + 30)}>Show more ({remaining})</Button> : null}
      {archive.nextCursor !== null ? <Button type="button" disabled={archive.loading} onClick={archive.loadEarlier}>Load earlier saved inputs</Button> : null}
    </div> : null}
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
        <header className="focus-local-inputs__header"><div className="focus-local-inputs__heading"><span className="focus-local-inputs__eyebrow">LOCAL LIBRARY</span>
          <Dialog.Title>Saved inputs</Dialog.Title><p>Drafts and queued messages, ready when you are.</p></div>
          <Dialog.Close asChild><IconButton className="focus-local-inputs__close" type="button" aria-label="Close saved inputs" title="Close"><CloseIcon size={15} /></IconButton></Dialog.Close></header>
        {issue ? <p role="status">{issue}</p> : null}
        {open ? <LocalRetainedInputs onOpenDraft={continueDraft} canOpenDraft={key => Boolean(onOpenLocation && availableDrafts?.get(key))} /> : null}
      </Dialog.Content>
    </DocumentOverlayPortal>
  </Dialog.Root>
}
