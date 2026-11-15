import * as Dialog from '@agentmux/client-ui/components/Modal'
import { ComposerTextarea } from '@agentmux/client-ui/input'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { useRef, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { SplitDirection } from '@agentmux/layout'
import { Button } from '@agentmux/client-ui/components/Button'
import { browserAgentCreationDraftKey, type BrowserAgentCreationOptions, type browserAgentCreationContext } from '../lib/browser-agent-creation'
import { useLauncherState } from '../lib/launcher-state'
import { DocumentOverlayPortal, getWindowOverlayHost } from './WindowOverlayHost'

export function BrowserAgentCreationOptionsDialog({ browserId, context, hostLabel, ownerDocument, onCreate, onClose, preparationIssue }: {
  browserId: string
  context: ReturnType<typeof browserAgentCreationContext>
  hostLabel: string
  preparationIssue?: string | undefined
  ownerDocument: Document
  onCreate(options: BrowserAgentCreationOptions): Promise<string | null>
  onClose(): void
}) {
  const draftKey = browserAgentCreationDraftKey(browserId)
  const draft = useLauncherState(state => state.drafts[draftKey])
  const persistenceIssue = useLauncherState(state => state.persistenceIssue)
  const [pending, setPending] = useState(false), [failure, setFailure] = useState<string | null>(null)
  const field = useRef<HTMLSelectElement>(null)
  const hostChanged = Boolean(draft?.browserAgent?.hostId && draft.browserAgent.hostId !== context.workspace?.hostId)
  const executorId = hostChanged ? '' : draft?.browserAgent?.executorId ?? context.defaultExecutorId ?? ''
  const split = draft?.browserAgent?.split ?? 'right'
  const task = draft?.prompt ?? ''
  const write = (patch: { prompt?: string; executorId?: string; split?: SplitDirection }) => useLauncherState.getState().setBrowserAgentDraft(draftKey,
    { ...(hostChanged ? { executorId: '' } : {}), hostId: context.workspace?.hostId ?? '', ...patch })
  async function create() {
    if (pending) return
    if (!executorId) { setFailure('Choose an Executor on this execution Host. Your task is kept.'); return }
    setPending(true); setFailure(null)
    try {
      const error = await onCreate({ executorId, split, task })
      if (error) setFailure(error)
      else onClose()
    } catch (error) { setFailure(presentError(error)) }
    finally { setPending(false) }
  }
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
    <DocumentOverlayPortal component={Dialog.Portal} container={getWindowOverlayHost(ownerDocument)}>
      <Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
      <Dialog.Content className="confirmation-dialog dialog-surface browser-agent-create-options" aria-busy={pending}
        onOpenAutoFocus={event => { event.preventDefault(); field.current?.focus() }}>
        <Dialog.Title className="confirmation-dialog__title">New Browser Agent</Dialog.Title>
        <Dialog.Description className="confirmation-dialog__description">Create a collaborator for this page and give it control. A task is optional.</Dialog.Description>
        <p className="browser-agent-create-options__execution"><span>{context.profileLabel ? <>{context.profileLabel}{'\u00a0·\u00a0'}</> : null}Runs on <strong>{hostLabel}</strong></span><code>{preparationIssue ? 'Execution directory unconfirmed' : context.workspace?.path ?? 'Execution directory unconfirmed'}</code></p>
        <form onSubmit={event => { event.preventDefault(); void create() }} onKeyDown={event => {
          if (event.key === 'Enter' && isImeOwnedKeyboardEvent(event.nativeEvent)) event.preventDefault()
        }}>
          <label className="confirmation-dialog__field">Executor<select ref={field} value={executorId} disabled={pending} required
            onChange={event => write({ executorId: event.target.value })}>
            <option value="">Choose an Executor</option>
            {executorId && !context.executors.some(executor => executor.id === executorId) ? <option value={executorId}>{executorId} · Original selection unavailable</option> : null}
            {context.executors.map(executor => <option key={executor.id} value={executor.id}>{executor.label}{executor.detail ? ` · ${executor.detail}` : ''}</option>)}
          </select></label>
          <label className="confirmation-dialog__field">Open next to this page<select value={split} disabled={pending} onChange={event => write({ split: event.target.value as SplitDirection })}>
            <option value="right">Right</option><option value="left">Left</option><option value="down">Below</option><option value="up">Above</option>
          </select></label>
          <label className="confirmation-dialog__field">Task <span className="browser-agent-create-options__optional">Optional · without a task, observe the page and wait</span>
            <ComposerTextarea syntax="markdown" aria-label="Task for new Browser Agent" value={task} onValueChange={value => write({ prompt: value, executorId, split })} rows={4} disabled={pending}
              placeholder="What should this Agent do on this page?" /></label>
          {hostChanged ? <p className="surface-inline-error" role="status">The execution Host changed since these options were saved. Choose its Executor explicitly; your task is kept.</p> : null}
          {persistenceIssue ? <p className="surface-inline-error" role="status">{persistenceIssue}</p> : null}
          {preparationIssue && !failure && !pending ? <p className="surface-inline-error" role="status">{preparationIssue} Your task and choices remain editable; Create retries this directory preparation.</p> : null}
          {failure ? <p className="surface-inline-error" role="alert">{failure}</p> : null}
          <footer><Button type="button" className="confirmation-dialog__cancel" onClick={onClose}>{pending ? 'Close' : 'Cancel'}</Button>
            <Button type="submit" variant="primary" disabled={pending}>{pending ? 'Creating…' : 'Create and give control'}</Button></footer>
        </form>
      </Dialog.Content>
    </DocumentOverlayPortal>
  </Dialog.Root>
}
