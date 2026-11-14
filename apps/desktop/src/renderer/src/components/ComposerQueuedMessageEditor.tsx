import { ComposerTextarea } from '@agentmux/client-ui/input'
import { Button } from '@agentmux/client-ui/components/Button'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { ComposerEditFooter } from '@agentmux/client-ui/components/ComposerEditFooter'
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { ComposerQueuedMessage } from './ComposerOutbox'

export type EditQueuedMessage = (id: string, expectedText: string, nextText: string) => Promise<void>
const editorLabel = '编辑待发消息'

/** Local edit draft; the queue owner rechecks identity, original text and admission on Save. */
export function ComposerQueuedMessageEditor({ entry, onSave, onCancel, status, tools }: {
  entry: ComposerQueuedMessage
  onSave: EditQueuedMessage
  onCancel: () => void
  status?: ReactNode
  tools?: ReactNode
}) {
  const fieldId = useId()
  const editorRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [original] = useState(entry.text)
  const [text, setText] = useState(entry.text)
  const inFlight = useRef(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useLayoutEffect(() => { editorRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }, [error, entry.editable])
  const save = async () => {
    if (inFlight.current || !entry.editable || !text.trim()) return
    inFlight.current = true
    setSaving(true); setError(null)
    try { await onSave(entry.id, original, text); onCancel() }
    catch (failure) { setError(presentError(failure)); textareaRef.current?.focus({ preventScroll: true }) }
    finally { inFlight.current = false; setSaving(false) }
  }
  return <div ref={editorRef} className="composer-queued-editor" data-editing-id={entry.id} onKeyDown={event => {
    // Arrow/Home/End and Enter belong to this text draft, never floating queue navigation or Send.
    event.stopPropagation()
    if (!isImeOwnedKeyboardEvent(event) && event.key === 'Escape' && !saving) { event.preventDefault(); onCancel() }
  }}>
    <div className="composer-queued-editor__heading">
      <label htmlFor={fieldId}>{editorLabel}</label>
      {status}
    </div>
    <ComposerTextarea variant="compact" id={fieldId} ref={textareaRef} autoFocus aria-label={editorLabel} rows={3} value={text} onValueChange={setText} readOnly={saving} />
    <div className="agent-action-feedback" tabIndex={error ? 0 : undefined}>
      {!entry.editable ? <span role="status">原消息已锁定，编辑稿仍可复制。</span> : null}
      {error ? <span role="alert">{error}</span> : entry.editable
        ? <span role="status">{saving ? <><SemanticIcon name="status.loading" animation="spin" size={13} /> 正在保存待发消息</>
          : '保存修改后仍需单独发送。'}</span> : null}
    </div>
    <ComposerEditFooter leading={tools}>
      <Button onClick={onCancel} disabled={saving}>取消</Button>
      <Button variant="primary" aria-label="保存待发消息" aria-busy={saving} disabled={saving || !entry.editable || !text.trim()} onClick={() => { void save() }}>保存</Button>
    </ComposerEditFooter>
  </div>
}
