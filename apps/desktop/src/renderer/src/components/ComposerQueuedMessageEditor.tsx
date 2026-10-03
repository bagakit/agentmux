import { useLayoutEffect, useRef, useState } from 'react'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { ComposerQueuedMessage } from './ComposerOutbox'

export type EditQueuedMessage = (id: string, expectedText: string, nextText: string) => Promise<void>

/** Local edit draft; the queue owner rechecks identity, original text and admission on Save. */
export function ComposerQueuedMessageEditor({ entry, onSave, onCancel }: {
  entry: ComposerQueuedMessage
  onSave: EditQueuedMessage
  onCancel: () => void
}) {
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
    <label>编辑待发消息<textarea ref={textareaRef} autoFocus aria-label="编辑待发消息" value={text} onChange={event => setText(event.target.value)} readOnly={saving} /></label>
    {!entry.editable ? <p role="status">原消息已锁定，不能保存修改；编辑稿仍保留，可复制。</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <div className="composer-queued-editor__actions"><button type="button" className="composer-tool" onClick={onCancel} disabled={saving}>取消</button>
      <button type="button" className="composer-mailbox__send" aria-label="保存待发消息" disabled={saving || !entry.editable || !text.trim()} onClick={() => { void save() }}>{saving ? '保存中' : '保存'}</button></div>
  </div>
}
