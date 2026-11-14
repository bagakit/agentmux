import { cloneElement, useEffect, useRef, useState, type ComponentPropsWithoutRef, type ReactElement, type ReactNode } from 'react'
import { AnchoredChoice } from './AnchoredChoice.js'
import { TextInput } from '../input/TextInput.js'
import { SemanticIcon } from '../theme/semantic-icon.js'
import { focusChoice } from '../lib/choice-focus.js'
import { isImeOwnedKeyboardEvent } from '../lib/ime-keyboard-event.js'

/** A query and explicit actions in a named panel. The caller owns candidates and results. */
export function SearchChoiceDialog({ open: controlled, onOpenChange, label, searchLabel, clearLabel, trigger,
  className = "", boundary, previewOnHover = false, children }: {
  open?: boolean | undefined
  onOpenChange?(open: boolean): void
  label: string
  searchLabel: string
  clearLabel: string
  trigger: ReactElement<ComponentPropsWithoutRef<'button'>>
  className?: string
  boundary?: (trigger: HTMLButtonElement) => Element | null
  previewOnHover?: boolean
  children(query: string, choose: (action: () => void) => void): ReactNode
}) {
  const [localOpen, setLocalOpen] = useState(false)
  const [query, setQuery] = useState('')
  const open = controlled ?? localOpen
  const input = useRef<HTMLInputElement>(null)
  const preview = useRef(false)
  const selected = useRef(false)
  const focusPending = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const current = useRef({ open, onOpenChange })
  current.current = { open, onOpenChange }

  function change(next: boolean) {
    clearTimeout(timer.current)
    if (current.current.open === next) return
    current.current.open = next
    if (!next) { setQuery(''); focusPending.current = false }
    if (next) selected.current = false
    if (controlled === undefined) setLocalOpen(next)
    current.current.onOpenChange?.(next)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    if (!open) setQuery('')
  }, [open])
  const closePreview = (pointerType: string) => {
    if (preview.current && pointerType === 'mouse') {
      clearTimeout(timer.current)
      timer.current = setTimeout(() => { if (preview.current) change(false) }, 180)
    }
  }
  function enterSearch() {
    clearTimeout(timer.current)
    preview.current = false
    focusPending.current = true
    input.current?.focus({ preventScroll: true })
  }
  const choose = (action: () => void) => {
    if (!current.current.open || trigger.props.disabled) return
    selected.current = true
    action()
    change(false)
  }
  return <AnchoredChoice open={open} onOpenChange={change} label={label} boundary={boundary} onPlaced={() => { if (focusPending.current) enterSearch() }} trigger={cloneElement(trigger, {
    onPointerEnter: event => {
      if (previewOnHover && event.pointerType === 'mouse' && !event.buttons && !event.currentTarget.disabled) {
        clearTimeout(timer.current)
        if (!current.current.open) { preview.current = true; change(true) }
      }
    },
    onPointerLeave: event => closePreview(event.pointerType),
    onClick: event => {
      if (open && preview.current) { event.preventDefault(); enterSearch() }
      else if (!open) preview.current = false
    },
    onKeyDown: event => {
      if (event.currentTarget.disabled || isImeOwnedKeyboardEvent(event)) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || open && preview.current && ['Enter', ' '].includes(event.key)) {
        event.preventDefault()
        if (open) enterSearch()
        else { preview.current = false; change(true) }
      }
    }
  })} surface={{
    className: ('composer-menu--search ' + className).trim(),
    onOpenAutoFocus: event => { event.preventDefault(); if (!preview.current) enterSearch() },
    onCloseAutoFocus: event => { if (preview.current || selected.current) event.preventDefault() },
    onEscapeKeyDown: event => { if (isImeOwnedKeyboardEvent(event)) event.preventDefault() },
    onPointerEnter: () => clearTimeout(timer.current),
    onPointerLeave: event => closePreview(event.pointerType),
    onFocusCapture: () => { focusPending.current = false; preview.current = false; clearTimeout(timer.current) },
    onKeyDown: event => {
      if (isImeOwnedKeyboardEvent(event)) { event.stopPropagation(); return }
      if (event.target === input.current && event.key === 'Enter') { event.preventDefault(); return }
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      const target = event.target as HTMLElement
      const choices = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-choice]:not(:disabled)')]
      if (event.key === 'Enter' && choices.includes(target as HTMLButtonElement)) {
        event.preventDefault(); (target as HTMLButtonElement).click()
      } else if (focusChoice(event.nativeEvent, choices)) event.preventDefault()
    }
  }}>
    <div className="composer-menu__search">
      <TextInput ref={input} value={query} placeholder={searchLabel + '…'} aria-label={searchLabel}
        onChange={event => setQuery(event.currentTarget.value)} />
      {query ? <button type="button" className="composer-menu__clear" aria-label={clearLabel}
        onClick={() => { setQuery(''); enterSearch() }}><SemanticIcon name="action.close" size={12} /></button> : null}
    </div>
    {open && <div className="composer-menu__results">{children(query.trim().toLocaleLowerCase(), choose)}</div>}
  </AnchoredChoice>
}
