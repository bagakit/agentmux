import { semanticIconComponent } from '@agentmux/client-ui/icons'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { Button } from '@agentmux/client-ui/components/Button'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { restoreComposerInput } from '@agentmux/client-ui/composer-semantic-reference'
import { currentCoreSpatialGraph, useAppStore } from '../store'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { localRetainedInputs, type LocalInputTarget, type LocalRetainedInput } from '../lib/local-retained-inputs'
import { useWorkbenchInputArchive } from '../lib/use-workbench-input-archive'
import { archivedInputMatchesSession } from '../lib/workbench-input-archive'
import { useWorkbenchDocument } from '../lib/workbench-document'
import { useWorkbenchDocumentVisibility } from '../lib/workbench-window-registry'

const SavedInputIcon = semanticIconComponent('action.save')

function LocalInput({ input }: { input: LocalRetainedInput }) {
  const [copied, setCopied] = useState(false)
  const [open, setOpen] = useState(false)
  const body = open ? restoreComposerInput(input.text, input.entry?.inputImages) : ''
  const source = input.entry?.originalMember?.target
  return <details className="local-input-record" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><strong>{input.kind === 'draft' ? 'Draft' : 'Queue entry'}</strong><span>{input.text.slice(0, 100) || 'Saved image input'}</span>
      <small>{source?.runtimeId ?? input.target?.hostId ?? 'Association unknown'}</small></summary>
    {open ? <>
      <dl className="session-record-details__facts"><div><dt>Original key</dt><dd>{input.key}</dd></div>
        {input.entry ? <><div><dt>Operation</dt><dd>{input.entry.operationId}</dd></div>
          <div><dt>Saved state</dt><dd>{input.entry.status}{input.entry.archived ? ' · retained' : ''}{input.entry.movedToDraft ? ' · moved to draft' : ''}{input.entry.awaitingExplicitSend ? ' · explicit send required' : ''}</dd></div>
          <div><dt>Original delivery receipt</dt><dd>{input.entry.inputReceipt ? `${input.entry.inputReceipt.status} · ${input.entry.inputReceipt.persistence}` : input.entry.resumeInputReceipt?.state ?? 'Not recorded here'}</dd></div></> : null}
        <div><dt>Association</dt><dd>{source ? `Runtime ${source.runtimeId} / ${source.agentSessionId}` : input.target ? `${input.target.hostId} / ${input.target.agentSessionId}` : 'Unknown · original key kept'}</dd></div>
      </dl>
      <textarea aria-label="Original saved input" readOnly value={body} rows={Math.min(8, Math.max(3, body.split('\n').length))} />
      <Button type="button" onClick={() => void copyTextToClipboard(body,
        error => useAppStore.getState().reportError(error, { kind: 'indeterminate', summary: 'Copying the original saved input was not confirmed. Its content and state are kept; retry copying.' })).then(setCopied)}>{copied ? 'Copied' : 'Copy saved input'}</Button>
    </> : null}
  </details>
}

/** Mounted only by an explicit reader. It never edits or re-admits the original intent. */
export function LocalRetainedInputs({ target }: { target?: LocalInputTarget }) {
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
  return <div className="local-retained-inputs" aria-label={target ? 'Local inputs for original Session' : 'All saved local inputs'}>
    <p>Saved in this client. Copying does not send, retry or restore an Agent.</p>
    {!target ? <p className="muted">Old entries without a confirmed binding keep their original key and remain available here.</p> : null}
    {inputs.slice(0, limit).map((input, index) => <LocalInput key={JSON.stringify([input.kind, input.key, input.entry?.operationId, index])} input={input} />)}
    {archived.map(input => <LocalInput key={JSON.stringify([input.key, input.entry!.operationId])} input={input} />)}
    {!inputs.length && !archived.length && !archive.loading && !archive.error && archive.nextCursor === null ? <p>{target ? 'No exactly associated local inputs are listed. Unassociated entries remain in Focus → Drafts & queue.' : 'No saved drafts or queue entries are listed in this client.'}</p> : null}
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

export function LocalRetainedInputsPanel() {
  const [open, setOpen] = useState(false)
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild><button type="button" className="focus-local-inputs-trigger" title="Saved drafts and retained queue entries" aria-label="Drafts & queue"><SavedInputIcon size={14} /><span>Drafts &amp; queue</span></button></Dialog.Trigger>
    <DocumentOverlayPortal component={Dialog.Portal}>
      <Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
      <Dialog.Content className="dialog-surface session-record-dialog focus-local-inputs" onPointerDownCapture={event => event.stopPropagation()}>
        <header><Dialog.Title>Saved drafts &amp; queue</Dialog.Title><Dialog.Close asChild><Button type="button">Close</Button></Dialog.Close></header>
        <Dialog.Description>Saved drafts and retained queue entries in this client.</Dialog.Description>
        {open ? <LocalRetainedInputs /> : null}
      </Dialog.Content>
    </DocumentOverlayPortal>
  </Dialog.Root>
}
