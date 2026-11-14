import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import { TextInput } from '@agentmux/client-ui/input'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { FocusNameEditor, FocusNameSave } from '../lib/focus-name-edit'

const EditIcon = semanticIconComponent('action.edit')
type Feedback =
  | { kind: 'review' | 'checked'; message: string }
  | { kind: 'confirm'; message: string; operationId: string; version: number; nameRevision: number }

/** One editor holds one original name owner and its last observed revision. */
export function FocusAgentNameEdit({ name, revision, owner, className, sessionId, onClose, children }: {
  name: string; revision: number; owner: FocusNameEditor; className: string
  sessionId: string; onClose(restoreFocus: boolean): void; children?: ReactNode
}) {
  const [draft, setDraft] = useState(name)
  const [progress, setProgress] = useState<'Saving name…' | 'Checking name…' | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const basis = useRef(revision)
  const editVersion = useRef(0), operation = useRef<object | null>(null)
  const surface = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const feedbackId = useId()
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
    return () => { operation.current = null }
  }, [])

  function close() {
    const editor = surface.current
    onClose(Boolean(editor?.contains(editor.ownerDocument.activeElement)))
  }

  function settle(result: FocusNameSave, version: number) {
    if (!result.applied) {
      setFeedback({ kind: 'review', message: result.issue ?? 'The name was not applied. Check the current name before saving again.' })
    } else if (result.diskDurability !== 'confirmed') {
      setFeedback({ kind: 'confirm', operationId: result.operationId, version, nameRevision: result.nameRevision,
        message: result.issue ?? 'The name was applied. Its disk save is unconfirmed.' })
    } else {
      basis.current = result.nameRevision
      if (editVersion.current === version) close()
      else setFeedback({ kind: 'checked', message: 'Earlier name saved. Your newer draft is ready to save.' })
    }
  }

  async function run(label: NonNullable<typeof progress>, action: (current: () => boolean) => Promise<void>) {
    if (operation.current) return
    const token = {}
    operation.current = token
    const current = () => operation.current === token
    setProgress(label)
    try { await action(current) }
    catch (error) {
      if (current()) setFeedback(feedback?.kind === 'confirm'
        ? { ...feedback, message: presentError(error) }
        : { kind: 'review', message: presentError(error) })
    }
    finally {
      if (current()) { operation.current = null; setProgress(null) }
    }
  }

  const needsCheck = feedback?.kind === 'review' || feedback?.kind === 'confirm'
  function save() {
    if (needsCheck) return
    const version = editVersion.current
    void run('Saving name…', async current => {
      const result = await owner.save(draft.trim() || null, basis.current)
      if (current()) settle(result, version)
    })
  }
  function check() {
    void run('Checking name…', async current => {
      if (feedback?.kind === 'confirm') {
        const result = await owner.confirm(feedback.operationId)
        if (!current()) return
        if (result.applied && result.diskDurability === 'confirmed' && result.nameRevision !== feedback.nameRevision) {
          setFeedback({ kind: 'review', message: 'Your earlier save was confirmed. The name has changed since then. Check the current name before saving again.' })
        } else settle(result, feedback.version)
      } else {
        const actual = await owner.inspect()
        if (!current()) return
        basis.current = actual.nameRevision
        setFeedback({ kind: 'checked', message: `Current name: ${actual.override ?? 'default'}. Your draft is kept.` })
      }
    })
  }

  return <div ref={surface} className={`${className} focus-context--renaming`} data-session-id={sessionId} onKeyDown={event => {
    event.stopPropagation()
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') { event.preventDefault(); close() }
    if (event.key === 'Enter' && event.target === input.current) { event.preventDefault(); save() }
  }}>
    <div className="focus-context__rename-line">
      <EditIcon size={16} className="focus-context__rename-mark" aria-hidden="true" />
      <TextInput ref={input} className="focus-context__rename" value={draft} aria-label={`Rename Agent ${name}`}
        aria-describedby={progress || feedback ? feedbackId : undefined}
        onChange={event => { ++editVersion.current; setDraft(event.target.value) }} />
    </div>
    <div className="focus-context__rename-actions">
      {needsCheck ? <Button aria-disabled={progress !== null || undefined} onClick={check}>{feedback.kind === 'confirm' ? 'Confirm saved name' : 'Check current name'}</Button>
        : <Button aria-disabled={progress !== null || undefined} onClick={save}>Save name</Button>}
      <Button onClick={close} aria-label={progress || feedback?.kind === 'confirm' ? 'Close rename editor' : 'Cancel rename'}>{progress || feedback?.kind === 'confirm' ? 'Close editor' : 'Cancel'}</Button>
    </div>
    {progress || feedback ? <p role="status" id={feedbackId} className="focus-context__rename-feedback">{progress ?? feedback?.message}</p> : null}
    {children}
  </div>
}
