import * as Dialog from '@radix-ui/react-dialog'
import { useLayoutEffect, useRef, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { Notebook, NotebookPage } from '@agentmux/core/notebook-catalog'
import type { AgentMuxSpaceMutationReport } from '@agentmux/core/control'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { executorsForHost } from '../lib/executors'
import { talkWithNoteAgent } from '../lib/note-agent-context'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { useAppStore } from '../store'
import { AgentExecutorPicker } from './AgentExecutorPicker'
import { resolveOverlayContainer } from './WindowOverlayHost'
import '../styles/note-talk-agent.css'

const ThemeActionCloseIcon = semanticIconComponent('action.close')


type Operation = { requestId: string; busy: boolean; dispatched: boolean; report?: AgentMuxSpaceMutationReport | undefined; issue?: string | undefined }

/** The controller outlives its dialog; dismissing an unknown receipt never repeats creation. */
export function NoteTalkAgent({ page, notebook, visible, onDismiss, onActivate, onSelectReference, onRestoreFocus }: {
  page: NotebookPage | null; notebook: Notebook | undefined; visible: boolean
  onDismiss(): void; onActivate(page: NotebookPage): void
  onRestoreFocus?: (() => void) | undefined
  onSelectReference?: ((reference: WorkbenchProjectionSelection) => void) | undefined
}) {
  const config = useAppStore(state => state.config), detections = useAppStore(state => state.executorDetections)
  const inventories = useAppStore(state => state.hostExecutorInventories)
  const [operations, setOperations] = useState<Record<string, Operation>>({})
  const held = useRef(operations), target = useRef(page), active = useRef(visible)
  const openedBesideNote = useRef(false)
  const content = useRef<HTMLDivElement>(null), restoreAllowed = useRef(false)
  const origin = useRef<Pick<ReturnType<typeof useAppStore.getState>, 'mainSurface' | 'recallNotebookId' | 'recallNoteId' | 'recallZoneSelection'> | null>(null)
  held.current = operations; target.current = page; active.current = visible
  const operation = page ? operations[page.noteId] : undefined
  function update(noteId: string, next: Operation) {
    held.current = { ...held.current, [noteId]: next }; setOperations(held.current)
  }
  useLayoutEffect(() => {
    if (page) {
      openedBesideNote.current = false; restoreAllowed.current = false
      const state = useAppStore.getState()
      origin.current = { mainSurface: state.mainSurface, recallNotebookId: state.recallNotebookId,
        recallNoteId: state.recallNoteId, recallZoneSelection: state.recallZoneSelection }
    }
    if (!page || held.current[page.noteId]) return
    const prefix = `note-talk:${encodeURIComponent(page.noteId)}:`
    const retained = Object.values(useAppStore.getState().spatialRequests).filter(binding =>
      binding.operation === 'agent.open' && binding.createAgent && binding.requestId.startsWith(prefix)).at(-1)
    if (retained) update(page.noteId, { requestId: retained.requestId, busy: false, dispatched: true,
      issue: 'An earlier Agent operation is retained. Check its result without starting it again.' })
  }, [page?.noteId])
  function dismiss() {
    restoreAllowed.current = Boolean(content.current?.contains(document.activeElement))
    onDismiss()
  }
  async function start(executorId: string) {
    const original = target.current
    if (!original || !notebook || held.current[original.noteId]?.busy || held.current[original.noteId]?.dispatched) return
    const requestId = `note-talk:${encodeURIComponent(original.noteId)}:${crypto.randomUUID()}`
    update(original.noteId, { requestId, busy: true, dispatched: false })
    onActivate(original)
    const authorize = () => active.current && target.current?.noteId === original.noteId &&
      useAppStore.getState().mainSurface === 'recall' && useAppStore.getState().recallNoteId === original.noteId
    try {
      const report = await talkWithNoteAgent({ page: original, notebook, executorId, requestId,
        selectedReference: useAppStore.getState().recallZoneSelection?.active, authorize, onSelectReference })
      update(original.noteId, { requestId, busy: false, dispatched: true, report })
      if (report.outcome === 'opened' && target.current?.noteId === original.noteId) {
        openedBesideNote.current = true; onDismiss()
      }
    } catch (cause) {
      const dispatched = Boolean(useAppStore.getState().spatialRequests[requestId])
      update(original.noteId, { requestId, busy: false, dispatched, issue: presentError(cause) })
    }
  }
  async function inspect() {
    const original = target.current, prior = original ? held.current[original.noteId] : undefined
    if (!original || !prior || prior.busy) return
    update(original.noteId, { ...prior, busy: true })
    try {
      const result = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: `note-talk-check:${crypto.randomUUID()}`,
        operation: 'space.inspect', target: { requestId: prior.requestId } })
      if (result.operation !== 'space.inspect') throw new Error('The original Agent operation returned an unrelated receipt.')
      const report = result.request?.report ?? undefined
      update(original.noteId, { ...prior, busy: false, report, issue: report ? undefined : 'The original result is still unconfirmed. Creation has not been repeated.' })
    } catch (cause) { update(original.noteId, { ...prior, busy: false, issue: presentError(cause) }) }
  }
  const executors = page ? executorsForHost(config, page.resource.hostId, detections, inventories[page.resource.hostId]) : []
  return <Dialog.Root open={visible && Boolean(page)} onOpenChange={open => { if (!open) dismiss() }}>
    <Dialog.Portal container={resolveOverlayContainer()}>
      <Dialog.Overlay className="dialog-scrim" />
      <Dialog.Content ref={content} className="notebook-create-dialog dialog-surface note-talk-dialog" onCloseAutoFocus={event => {
        event.preventDefault()
        const state = useAppStore.getState(), original = origin.current
        if (!openedBesideNote.current && active.current && restoreAllowed.current && original &&
            state.mainSurface === original.mainSurface && state.recallNotebookId === original.recallNotebookId &&
            state.recallNoteId === original.recallNoteId && state.recallZoneSelection === original.recallZoneSelection) onRestoreFocus?.()
      }}>
        <header><Dialog.Title>Talk with Agent</Dialog.Title><button type="button" className="icon-button" aria-label="Close Agent selection" onClick={dismiss}><ThemeActionCloseIcon size={15} /></button></header>
        <Dialog.Description className="notebook-create-description">Discuss <strong>{page?.title}</strong> beside this note. Choose an Agent to begin.</Dialog.Description>
        {!operation?.dispatched ? <AgentExecutorPicker executors={executors} selected={null} disabled={Boolean(operation?.busy)} onSelect={id => { void start(id) }} /> : null}
        {operation?.busy ? <p role="status">{operation.dispatched ? 'Checking the original Agent operation...' : 'Opening this note and its Agent...'}</p> : null}
        {operation?.issue ? <p className="notebook-create-issue" role="status">{operation.issue}</p> : null}
        {operation?.report?.agent ? <p role="status">Agent <code>{operation.report.agent.agentSessionId}</code> is retained.</p> : null}
        {operation?.report?.issues.map(issue => <p key={`${issue.step}:${issue.code}`} className="notebook-create-issue" role="status">{issue.message} {issue.recovery}</p>)}
        {operation?.dispatched ? <button type="button" className="small-button" disabled={operation.busy} onClick={() => { void inspect() }}>Check Agent operation</button> : null}
        {operation?.report?.outcome === 'opened' && page ? <button type="button" className="small-button" onClick={() => {
          const next = { ...held.current }; delete next[page.noteId]; held.current = next; setOperations(next)
        }}>Start another Agent</button> : null}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
