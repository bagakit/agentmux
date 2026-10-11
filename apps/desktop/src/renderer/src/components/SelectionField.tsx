import { useWorkbenchDocument } from '../lib/workbench-document'
import * as Menu from '@radix-ui/react-dropdown-menu'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { DocumentOverlayPortal } from './WindowOverlayHost'

const ThemeNavigationDownIcon = semanticIconComponent('navigation.down')
const ThemeStatusSelectedIcon = semanticIconComponent('status.selected')
const ThemeActionCloseIcon = semanticIconComponent('action.close')


export interface SelectionOption { value: string; label: string; disabled?: boolean; icon?: ReactNode; description?: string }

/** Controlled presentation only. The caller owns options, saved identity and domain actions. */
export function SelectionField({ id, label, value, options, onValueChange, disabled = false, className = '', menuClassName = '', menuBoundary, triggerLabel, searchable }: {
  id?: string | undefined; label: string; value: string; options: readonly SelectionOption[]
  onValueChange(value: string): void; disabled?: boolean; className?: string; menuClassName?: string; menuBoundary?: HTMLElement | null; triggerLabel?: string | undefined; searchable?: boolean
}) {
  const ownerDocument = useWorkbenchDocument()
  const descriptionId = useId(), trigger = useRef<HTMLButtonElement>(null)
  const [query, setQuery] = useState(''), [open, setOpen] = useState(false), [searchSession, setSearchSession] = useState(false)
  const search = useRef<HTMLInputElement>(null), menu = useRef<HTMLDivElement>(null)
  const canSearch = searchable !== false && (open ? searchSession : searchable ?? options.length > 8)
  useEffect(() => {
    if (!open || !canSearch) return
    const ownerWindow = ownerDocument.defaultView!
    const frame = ownerWindow.requestAnimationFrame(() => search.current?.focus({ preventScroll: true }))
    return () => ownerWindow.cancelAnimationFrame(frame)
  }, [open, canSearch, ownerDocument])
  const needle = query.trim().toLocaleLowerCase()
  const visibleOptions = canSearch && needle ? options.filter(option => `${option.label} ${option.description ?? ''}`.toLocaleLowerCase().includes(needle)) : options
  const focusOption = (last = false) => {
    const items = menu.current?.querySelectorAll<HTMLElement>('[role=menuitemradio]:not([aria-disabled=true])')
    const target = items?.[last ? items.length - 1 : 0]
    target?.focus()
  }
  const selected = options.find(option => option.value === value)
  const currentLabel = selected?.label ?? 'Saved selection · not in current options'
  const currentDescription = selected?.description ? `${currentLabel} · ${selected.description}` : currentLabel
  return <Menu.Root open={open} onOpenChange={open => {
    setOpen(open)
    if (open) { setSearchSession(searchable ?? options.length > 8) }
    else { setQuery(''); setSearchSession(false) }
  }}>
    <Menu.Trigger asChild>
      <button ref={trigger} id={id} type="button" className={`selection-field ${className}`} aria-label={label}
        aria-describedby={descriptionId} data-value={value} title={selected ? currentDescription : `${currentLabel}: ${value}`} disabled={disabled}>
        <span className="selection-field__choice">{selected?.icon ? <span className="selection-field__icon" inert aria-hidden="true">{selected.icon}</span> : null}<span>{triggerLabel ?? currentLabel}</span></span><span id={descriptionId} hidden>{selected ? currentDescription : `${currentLabel}: ${value}`}</span><ThemeNavigationDownIcon size={13} aria-hidden="true" />
      </button>
    </Menu.Trigger>
    <DocumentOverlayPortal component={Menu.Portal}>
      <div className="window-overlay-host__entry" data-overlay-layer="popover"><Menu.Content ref={menu} onEscapeKeyDown={event => { if (isImeOwnedKeyboardEvent(event)) event.preventDefault() }} onKeyDown={event => {
        if (canSearch && event.target !== search.current && !isImeOwnedKeyboardEvent(event) && event.key === 'Tab') {
          event.preventDefault()
          if (event.shiftKey && query) menu.current?.querySelector<HTMLButtonElement>('.selection-field__clear')?.focus()
          else search.current?.focus({ preventScroll: true })
        }
      }} className={`tab-context-menu selection-field__menu ${menuClassName}`} align="start" sideOffset={4} collisionPadding={8} collisionBoundary={menuBoundary ?? []} aria-label={label} data-searchable={canSearch || undefined}>
        {canSearch ? <div className="selection-field__search">
          <TextInput ref={search} aria-label={`Find ${label.toLocaleLowerCase()}`} placeholder="Find options…" value={query}
            onChange={event => setQuery(event.target.value)} onKeyDown={event => {
              if (isImeOwnedKeyboardEvent(event)) { event.stopPropagation(); return }
              if (event.key === 'Escape') return
              event.stopPropagation()
              if (event.key === 'Enter') { event.preventDefault(); return }
              if (event.ctrlKey || event.metaKey || event.altKey) return
              if (event.key === 'Tab' && query && !event.shiftKey) { event.preventDefault(); menu.current?.querySelector<HTMLButtonElement>('.selection-field__clear')?.focus() }
              else if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Tab') { event.preventDefault(); focusOption(event.key === 'ArrowUp' || event.shiftKey) }
            }} />
          {query ? <button type="button" className="selection-field__clear" aria-label="Clear option search" onClick={() => { setQuery(''); search.current?.focus({ preventScroll: true }) }} onKeyDown={event => { if (event.key !== 'Escape') { event.stopPropagation(); if (event.key === 'Tab') { event.preventDefault(); if (event.shiftKey) search.current?.focus({ preventScroll: true }); else focusOption() } } }}><ThemeActionCloseIcon size={12} /></button> : null}
        </div> : null}
        <div className="selection-field__results">
        <Menu.RadioGroup value={value} onValueChange={next => {
          if (!disabled && options.some(option => option.value === next && !option.disabled)) onValueChange(next)
        }}>
          {!selected ? <Menu.RadioItem className="tab-context-menu__item selection-field__option" value={value} disabled>
            <span className="selection-field__mark"><ThemeStatusSelectedIcon size={13} /></span><span title={value}>{currentLabel}</span>
          </Menu.RadioItem> : null}
          {visibleOptions.map(option => <Menu.RadioItem key={option.value} value={option.value} data-value={option.value} disabled={disabled || (option.disabled ?? false)}
            textValue={option.label} className="tab-context-menu__item selection-field__option">
            <span className="selection-field__mark"><Menu.ItemIndicator><ThemeStatusSelectedIcon size={13} /></Menu.ItemIndicator></span>
            <span className="selection-field__choice" title={option.description ? `${option.label} · ${option.description}` : option.label}>{option.icon ? <span className="selection-field__icon" inert aria-hidden="true">{option.icon}</span> : null}<span>{option.label}{option.description ? <small className="selection-field__description">{option.description}</small> : null}</span></span>
          </Menu.RadioItem>)}
        </Menu.RadioGroup>
        {canSearch && !visibleOptions.length ? <p className="selection-field__empty" role="status">No matching options.</p> : null}
        </div>
      </Menu.Content></div>
    </DocumentOverlayPortal>
  </Menu.Root>
}
