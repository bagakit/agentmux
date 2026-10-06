import { TextInput } from '@agentmux/client-ui/input'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import * as Dialog from '@radix-ui/react-dialog'
import { useId, useLayoutEffect, useRef, useState } from 'react'
import { resolveOverlayContainer } from '../WindowOverlayHost'

export type AnnotationFileActionResult = { status: 'done' } |
  { status: 'error' | 'conflict' | 'unknown'; message: string }

type Feedback = Exclude<AnnotationFileActionResult, { status: 'done' }> | { status: 'checked'; message: string }

/** The host owns file revisions, IO and document replacement; this dialog holds only the request UI. */
export function AnnotationFileDialog({ mode, initialPath, onSubmit, onCheck, onClose }: {
  mode: 'open' | 'save'
  initialPath: string
  onSubmit(path: string): Promise<AnnotationFileActionResult>
  onCheck?(path: string): Promise<AnnotationFileActionResult>
  onClose(): void
}) {
  const [path, setPath] = useState(initialPath), [busy, setBusy] = useState<'submit' | 'check' | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const input = useRef<HTMLInputElement>(null), content = useRef<HTMLDivElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null), openedContent = useRef<Element | null>(null)
  const epoch = useRef({}), pending = useRef<object | null>(null), closed = useRef(false)
  const unconfirmedPaths = useRef(new Set<string>())
  const fieldId = useId(), feedbackId = useId()
  useLayoutEffect(() => {
    epoch.current = {}; pending.current = null; closed.current = false; unconfirmedPaths.current.clear()
    setPath(initialPath); setBusy(null); setFeedback(null)
    return () => { epoch.current = {}; pending.current = null; closed.current = true }
  }, [mode, initialPath])

  function close() {
    if (closed.current) return
    closed.current = true; epoch.current = {}; pending.current = null
    onClose()
  }

  async function run(action: 'submit' | 'check') {
    const check = action === 'check', submittedPath = path
    if (closed.current || pending.current || !submittedPath.length ||
      (!check && unconfirmedPaths.current.has(submittedPath)) || (check && !onCheck)) return
    const lifetime = epoch.current, request = {}
    pending.current = request; setBusy(action); setFeedback(null)
    const current = () => !closed.current && epoch.current === lifetime && pending.current === request
    let result: AnnotationFileActionResult
    try { result = await (check ? onCheck!(submittedPath) : onSubmit(submittedPath)) }
    catch (error) {
      result = { status: !check && mode === 'save' ? 'unknown' : 'error', message: error instanceof Error ? error.message : String(error) }
    }
    if (!current()) return
    if (result.status === 'done') {
      if (!check) { close(); return }
      unconfirmedPaths.current.delete(submittedPath)
      setFeedback({ status: 'checked', message: 'File checked.' })
    } else {
      if (result.status === 'unknown' || result.status === 'conflict') unconfirmedPaths.current.add(submittedPath)
      setFeedback(result)
    }
    pending.current = null; setBusy(null)
  }

  const blocked = unconfirmedPaths.current.has(path)
  return <Dialog.Root open onOpenChange={open => { if (!open) close() }}>
    <Dialog.Portal container={resolveOverlayContainer()}>
      <Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
      <Dialog.Content ref={content} className="confirmation-dialog dialog-surface annotation-file-dialog" aria-busy={busy !== null}
        onOpenAutoFocus={event => {
          event.preventDefault()
          previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
          openedContent.current = event.target instanceof Element ? event.target : null
          input.current?.focus(); input.current?.select()
        }}
        onCloseAutoFocus={event => {
          event.preventDefault()
          const original = previousFocus.current, active = document.activeElement
          if (original?.isConnected && (active === document.body || active === original || !active?.isConnected || openedContent.current?.contains(active)))
            original.focus({ preventScroll: true })
        }}
        onEscapeKeyDown={event => { if (isImeOwnedKeyboardEvent(event)) event.preventDefault() }}>
        <Dialog.Title className="confirmation-dialog__title">{mode === 'save' ? 'Save editable original' : 'Open editable original'}</Dialog.Title>
        <Dialog.Description className="confirmation-dialog__description">{mode === 'save'
          ? 'Contains the original image and editable annotations. Use Copy PNG/context to share the processed result.'
          : 'Read an editable annotation document from a relative file in the current Workspace.'}</Dialog.Description>
        <form onSubmit={event => { event.preventDefault(); void run('submit') }}>
          <label htmlFor={fieldId}>Workspace file</label>
          <TextInput ref={input} id={fieldId} value={path} disabled={busy !== null} autoComplete="off" spellCheck={false}
            aria-invalid={feedback !== null && feedback.status !== 'checked'} aria-describedby={feedback || blocked ? feedbackId : undefined}
            onChange={event => { setPath(event.target.value); setFeedback(null) }}
            onKeyDown={event => { if (event.key === 'Enter' && isImeOwnedKeyboardEvent(event.nativeEvent)) event.preventDefault() }} />
          {feedback || blocked ? <p id={feedbackId} role={feedback?.status === 'checked' ? 'status' : 'alert'}
            className={feedback?.status === 'checked' ? 'confirmation-dialog__description' : 'surface-inline-error'}>
            {feedback?.message ?? 'Check this file before submitting the same path again.'}</p> : null}
          <footer>
            <button type="button" className="small-button" onClick={close}>Cancel</button>
            {blocked && onCheck ? <button type="button" className="small-button" disabled={busy !== null} onClick={() => void run('check')}>
              {busy === 'check' ? 'Checking…' : 'Check file'}</button> : null}
            <button type="submit" className="primary-button" disabled={busy !== null || !path.length || blocked}>
              {busy === 'submit' ? mode === 'save' ? 'Saving…' : 'Opening…' : mode === 'save' ? 'Save original' : 'Open original'}</button>
          </footer>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
