import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { TextInput } from '../input/TextInput.js'
import { focusChoice } from '../lib/choice-focus.js'
import { isImeOwnedKeyboardEvent } from '../lib/ime-keyboard-event.js'
import { SemanticIcon } from '../theme/semantic-icon.js'
import { AnchoredChoice } from './AnchoredChoice.js'

export type SelectionOption = { value: string; label: string; disabled?: boolean; icon?: ReactNode; description?: string }
export type SelectionFieldProps = {
  id?: string | undefined; label: string; value: string; options: readonly SelectionOption[]
  onValueChange(value: string): void; disabled?: boolean; className?: string; menuClassName?: string
  menuBoundary?: HTMLElement | null; menuContainer?: HTMLElement | null; triggerLabel?: string | undefined; searchable?: boolean
  open?: boolean; onOpenChange?(open: boolean): void; footer?: ReactNode
  labelledBy?: string | undefined; describedBy?: string | undefined
  missingOptionLabel?: string | undefined; missingOptionDescription?: string | undefined
}

/** A controlled value rendered through a single-select listbox. The host owns the value and available choices. */
export function SelectionField({ id, label, value, options, onValueChange, disabled = false, className = '', menuClassName = '',
  menuBoundary, menuContainer, triggerLabel, searchable, open: controlled, onOpenChange, footer, labelledBy, describedBy,
  missingOptionLabel = 'Not in current options', missingOptionDescription }: SelectionFieldProps) {
  const descriptionId = useId()
  const [localOpen, setLocalOpen] = useState(false), [query, setQuery] = useState(''), [searchSession, setSearchSession] = useState(options.length > 8)
  const open = controlled ?? localOpen
  const canSearch = searchable ?? (open ? searchSession : options.length > 8)
  const hasDialog = canSearch || Boolean(footer)
  const trigger = useRef<HTMLButtonElement>(null)
  const restoreSelectionFocus = useRef(false)
  const search = useRef<HTMLInputElement>(null), choices = useRef<HTMLDivElement>(null)
  const pendingFocus = useRef(false), typing = useRef({ text: '', at: 0 })
  const needle = query.trim().toLocaleLowerCase()
  const selected = options.find(option => option.value === value)
  const visible = canSearch && needle ? options.filter(option => [option.label, option.description].join(' ').toLocaleLowerCase().includes(needle)) : options
  const labelForValue = selected?.label ?? missingOptionLabel
  const description = selected?.description ? selected.label + ' · ' + selected.description : selected?.label ?? missingOptionDescription ?? labelForValue
  const title = selected ? description : labelForValue + (missingOptionDescription && missingOptionDescription !== labelForValue
    ? ' · ' + missingOptionDescription : '') + ': ' + value
  useEffect(() => {
    if (!open) { setQuery(''); setSearchSession(false); typing.current = { text: '', at: 0 }; pendingFocus.current = false }
  }, [open])

  const available = () => [...(choices.current?.querySelectorAll<HTMLButtonElement>('[role=option]:not(:disabled)') ?? [])]
  const focusInitial = () => {
    pendingFocus.current = true
    const options = available()
    const target = search.current ?? options.find(option => option.getAttribute('aria-selected') === 'true') ?? options[0]
    target?.focus({ preventScroll: true })
    if (target?.ownerDocument.activeElement === target) pendingFocus.current = false
  }
  function change(next: boolean) {
    if (next) restoreSelectionFocus.current = false
    if (controlled === undefined) setLocalOpen(next)
    setSearchSession(next && options.length > 8)
    onOpenChange?.(next)
  }
  function pick(option: SelectionOption) {
    if (disabled || option.disabled) return
    restoreSelectionFocus.current = true
    if (option.value !== value) onValueChange(option.value)
    change(false)
  }
  const row = (option: SelectionOption, missing = false) => <button key={option.value} type="button" role="option"
    aria-selected={option.value === value} aria-disabled={disabled || option.disabled || undefined} disabled={disabled || option.disabled}
    data-value={option.value} data-missing={missing || undefined} data-disabled={disabled || option.disabled ? '' : undefined}
    className="selection-field__option" tabIndex={-1} onClick={() => pick(option)}>
    <span className="selection-field__mark">{option.value === value && <SemanticIcon name="status.selected" size={13} />}</span>
    <span className="selection-field__choice" title={missing ? value : [option.label, option.description].filter(Boolean).join(' · ')}>
      {option.icon ? <span className="selection-field__icon" inert aria-hidden="true">{option.icon}</span> : null}
      <span>{option.label}{option.description ? <small className="selection-field__description">{option.description}</small> : null}</span>
    </span>
  </button>

  return <AnchoredChoice open={open} onOpenChange={change} label={label} placement="bottom-start" boundary={menuBoundary} container={menuContainer}
    onPlaced={() => { if (pendingFocus.current) focusInitial() }} trigger={<button ref={trigger} id={id} type="button"
      className={'selection-field ' + className} aria-label={label} aria-haspopup={hasDialog ? 'dialog' : 'listbox'}
      aria-describedby={[describedBy, descriptionId].filter(Boolean).join(' ')} aria-labelledby={labelledBy} data-value={value} title={title} disabled={disabled}
      onKeyDown={event => {
        if (isImeOwnedKeyboardEvent(event) || disabled) return
        if (['ArrowDown', 'ArrowUp', ' ', 'Enter'].includes(event.key)) {
          event.preventDefault()
          if (open) focusInitial(); else change(true)
        }
      }}>
      <span className="selection-field__choice">
        {selected?.icon ? <span className="selection-field__icon" inert aria-hidden="true">{selected.icon}</span> : null}
        <span>{triggerLabel ?? labelForValue}</span>
      </span><span id={descriptionId} hidden>{title}</span><SemanticIcon name="navigation.down" size={13} />
    </button>} surface={{
      role: hasDialog ? 'dialog' : 'listbox', 'aria-label': label, 'aria-orientation': hasDialog ? undefined : 'vertical',
      className: 'selection-field__menu ' + menuClassName,
      'data-searchable': canSearch || undefined,
      onOpenAutoFocus: event => { event.preventDefault(); focusInitial() },
      onCloseAutoFocus: event => {
        if (!restoreSelectionFocus.current) return
        event.preventDefault()
        const original = trigger.current
        if (!original?.isConnected || original.disabled) return
        const { activeElement, body } = original.ownerDocument
        if (activeElement === body || activeElement === original.closest('[data-overlay-modal-boundary]')) original.focus({ preventScroll: true })
      },
      onEscapeKeyDown: event => { if (isImeOwnedKeyboardEvent(event)) event.preventDefault() },
      onKeyDown: event => {
        if (isImeOwnedKeyboardEvent(event)) { event.stopPropagation(); return }
        if (event.target === search.current && event.key === 'Enter') { event.preventDefault(); return }
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
        const current = event.target as HTMLButtonElement
        const entries = available()
        if ((event.key === 'Enter' || event.key === ' ') && entries.includes(current)) {
          event.preventDefault(); current.click(); return
        }
        if (focusChoice(event.nativeEvent, entries)) { event.preventDefault(); return }
        if (canSearch || event.key.length !== 1 || event.key === ' ') return
        const letter = event.key.toLocaleLowerCase(), now = event.timeStamp
        const prefix = now - typing.current.at > 650 || typing.current.text === letter ? letter : typing.current.text + letter
        typing.current = { text: prefix, at: now }
        const start = entries.indexOf(current)
        const next = [...entries.slice(start + 1), ...entries.slice(0, start + 1)].find(option =>
          (option.querySelector('.selection-field__choice > span:last-child')?.firstChild?.textContent ?? '').toLocaleLowerCase().startsWith(prefix))
        if (next) { event.preventDefault(); next.focus() }
      }
    }}>
    {canSearch ? <div className="selection-field__search">
      <TextInput ref={search} aria-label={'Find ' + label.toLocaleLowerCase()} placeholder="Find options…" value={query}
        onChange={event => setQuery(event.currentTarget.value)} />
      {query ? <button type="button" className="selection-field__clear" aria-label="Clear option search"
        onClick={() => { setQuery(''); search.current?.focus({ preventScroll: true }) }}><SemanticIcon name="action.close" size={12} /></button> : null}
    </div> : null}
    <div ref={choices} className="selection-field__results" role={hasDialog ? 'listbox' : undefined} aria-label={hasDialog ? label : undefined}
      tabIndex={hasDialog ? 0 : undefined} onFocus={event => {
        if (event.target === event.currentTarget) available()[0]?.focus({ preventScroll: true })
      }}>
      {open && !selected && !needle ? row({ value, label: labelForValue }, true) : null}
      {open && visible.map(option => row(option))}
    </div>
    {canSearch && !visible.length ? <p className="selection-field__empty" role="status">No matching options.</p> : null}
    {footer ? <div className="selection-field__footer">{footer}</div> : null}
  </AnchoredChoice>
}
