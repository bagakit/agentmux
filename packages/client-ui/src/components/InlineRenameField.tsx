import { useId, useLayoutEffect, useRef } from 'react'
import { TextInput } from '../input/index.js'
import { SemanticIcon } from '../theme/icons.js'
import { isImeOwnedKeyboardEvent } from '../lib/ime-keyboard-event.js'

/** The caller owns validation, pending/error facts and the rename transaction. */
export function InlineRenameField({
  value, label, onValueChange, onCommit, onCancel, selectionEnd, pending = false,
  error = null, placeholder, inputClassName
}: {
  value: string
  label: string
  onValueChange: (value: string) => void
  /** Resolve after exposing any failure through error; this field never writes or validates names. */
  onCommit: (value: string) => Promise<void>
  onCancel: () => void
  selectionEnd?: number
  pending?: boolean
  error?: string | null
  placeholder?: string
  inputClassName?: string
}) {
  const input = useRef<HTMLInputElement>(null), errorId = useId()
  const current = useRef({ onCommit, pending })
  current.current = { onCommit, pending }
  const submitting = useRef(false), cancelled = useRef(false), composing = useRef(false)
  const blurredWhileComposing = useRef(false)
  const deferred = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useLayoutEffect(() => {
    cancelled.current = false
    const field = input.current
    if (field) {
      field.focus({ preventScroll: true })
      field.setSelectionRange(0, selectionEnd ?? field.value.length)
      field.scrollLeft = 0
    }
    return () => { cancelled.current = true; clearTimeout(deferred.current) }
  }, [])

  function commit(name: string) {
    if (cancelled.current || current.current.pending || submitting.current || composing.current) return
    submitting.current = true
    void current.current.onCommit(name).finally(() => { submitting.current = false })
  }

  return <span className="inline-rename-field" data-pending={pending || undefined}>
    <TextInput ref={input} className={`inline-rename-field__input ${inputClassName ?? ''}`}
      aria-label={label} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined}
      aria-busy={pending} value={value} readOnly={pending} placeholder={placeholder}
      spellCheck={false} autoComplete="off" autoCapitalize="off"
      onChange={event => onValueChange(event.target.value)}
      onClick={event => event.stopPropagation()}
      onDoubleClick={event => event.stopPropagation()}
      onCompositionStart={() => { composing.current = true }}
      onCompositionEnd={event => {
        composing.current = false
        const name = event.currentTarget.value
        onValueChange(name)
        if (!blurredWhileComposing.current) return
        blurredWhileComposing.current = false
        deferred.current = setTimeout(() => commit(name), 0)
      }}
      onFocus={() => { blurredWhileComposing.current = false }}
      onBlur={event => {
        if (composing.current) { blurredWhileComposing.current = true; return }
        commit(event.currentTarget.value)
      }}
      onKeyDown={event => {
        if (composing.current || isImeOwnedKeyboardEvent(event)) return
        if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); commit(event.currentTarget.value) }
        if (event.key === 'Escape' && !pending) {
          event.preventDefault(); event.stopPropagation(); cancelled.current = true; clearTimeout(deferred.current); onCancel()
        }
      }} />
    {pending ? <SemanticIcon name="status.loading" className="inline-rename-field__pending" size={12} aria-label="Saving name" /> : null}
    {error ? <span id={errorId} className="inline-rename-field__error" role="alert">{error}</span> : null}
  </span>
}
