import { ComposerTextarea } from '@agentmux/client-ui/input'
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
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useLayoutEffect(() => { editorRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }, [error, entry.editable])
  const save = async () => {
    if (saving || !entry.editable || !text.trim()) return
    setSaving(true); setError(null)
    try { await onSave(entry.id, original, text); onCancel() }
    catch (failure) { setError(presentError(failure)); textareaRef.current?.focus({ preventScroll: true }) }
    finally { setSaving(false) }
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
    <ComposerTextarea id={fieldId} ref={textareaRef} autoFocus aria-label={editorLabel} rows={3} value={text} onValueChange={setText} readOnly={saving} />
    {!entry.editable ? <p role="status">原消息已锁定，不能保存修改；编辑稿仍保留，可复制。</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <div className="composer-queued-editor__footer">
      {tools}
      <div className="composer-queued-editor__actions">
        <button type="button" className="composer-tool" onClick={onCancel} disabled={saving}>取消</button>
        <button type="button" className="composer-queued-editor__save" aria-label="保存待发消息" disabled={saving || !entry.editable || !text.trim()} onClick={() => { void save() }}>{saving ? '保存中' : '保存'}</button>
      </div>
    </div>
  </div>
}
