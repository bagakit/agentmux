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

const SavedInputIcon = semanticIconComponent('action.save')

function LocalInput({ input }: { input: LocalRetainedInput }) {
  const [copied, setCopied] = useState(false)
  const [open, setOpen] = useState(false)
  const body = open ? restoreComposerInput(input.text, input.entry?.inputImages) : ''
  return <details className="local-input-record" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><strong>{input.kind === 'draft' ? 'Draft' : 'Queue entry'}</strong><span>{input.text.slice(0, 100) || 'Saved image input'}</span>
      <small>{input.target ? input.target.hostId : 'Association unknown'}</small></summary>
    {open ? <>
      <dl className="session-record-details__facts"><div><dt>Original key</dt><dd>{input.key}</dd></div>
        {input.entry ? <><div><dt>Operation</dt><dd>{input.entry.operationId}</dd></div><div><dt>Saved state</dt><dd>{input.entry.status}{input.entry.archived ? ' · retained' : ''}{input.entry.awaitingExplicitSend ? ' · explicit send required' : ''}</dd></div></> : null}
        <div><dt>Association</dt><dd>{input.target ? `${input.target.hostId} / ${input.target.agentSessionId}` : 'Unknown · original key kept'}</dd></div>
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
  const inputs = useMemo(() => localRetainedInputs(drafts, queues, graph).filter(input => !target ||
    input.target?.hostId === target.hostId && input.target.agentSessionId === target.agentSessionId), [drafts, queues, graph, target?.hostId, target?.agentSessionId])
  return <div className="local-retained-inputs" aria-label={target ? 'Local inputs for original Session' : 'All saved local inputs'}>
    <p>Saved in this client. Copying does not send, retry or restore an Agent.</p>
    {!target ? <p className="muted">Old entries without a confirmed binding keep their original key and remain available here.</p> : null}
    {inputs.slice(0, limit).map((input, index) => <LocalInput key={JSON.stringify([input.kind, input.key, input.entry?.operationId, index])} input={input} />)}
    {!inputs.length ? <p>{target ? 'No exactly associated local inputs are listed. Unassociated entries remain in Focus → Drafts & queue.' : 'No saved drafts or queue entries are listed in this client.'}</p> : null}
    {inputs.length > limit ? <Button type="button" onClick={() => setLimit(value => value + 30)}>Show more ({inputs.length - limit})</Button> : null}
  </div>
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
