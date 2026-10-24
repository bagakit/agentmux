import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import { TextInput } from '@agentmux/client-ui/input'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { GitHistoryRef } from '../../../../../shared/git-contracts'
import { WindowOverlayPortal } from '../../../components/WindowOverlayHost'
import { useWorkbenchDocument } from '../../../lib/workbench-document'

const ThemeNavigationDownIcon = semanticIconComponent('navigation.down')
const ThemeActionCloseIcon = semanticIconComponent('action.close')
const ThemeStatusSelectedIcon = semanticIconComponent('status.selected')
const ROW_HEIGHT = 44
const kindLabel = { local: 'Local', remote: 'Remote', head: 'HEAD', tag: 'Tag' }
const refLabel = (name: string) => name.replace(/^refs\/(heads|remotes)\//u, '')

export const GitHistoryRefPicker = memo(function GitHistoryRefPicker({ refs, reference, onSelect, enabled, scope, title }: {
  refs: GitHistoryRef[]; reference: string | null; onSelect(value: string | null): void
  enabled: boolean; scope: string; title?: string | undefined
}) {
  const ownerDocument = useWorkbenchDocument()
  const id = useId(), listId = id + '-references'
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null), scroller = useRef<HTMLDivElement>(null)
  const composing = useRef(false)
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [active, setActive] = useState(-1)
  const available = useMemo(() => refs.filter(ref => ref.kind !== 'tag'), [refs])
  const needle = query.trim().toLocaleLowerCase()
  const matches = useMemo(() => available.filter(ref => `${ref.name} ${kindLabel[ref.kind]}`.toLocaleLowerCase().includes(needle)), [available, needle])
  const options = useMemo(() => [
    ...(!needle ? [{ value: null, label: 'All branches', kind: 'Scope', description: 'Local branches, remote-tracking references and HEAD' }] : []),
    ...matches.map(ref => ({ value: ref.name, label: refLabel(ref.name), kind: kindLabel[ref.kind], description: ref.name }))
  ], [matches, needle])
  const selected = available.find(ref => ref.name === reference)
  const label = reference === null ? 'All branches' : selected ? `${kindLabel[selected.kind]} · ${refLabel(reference)}` : `Saved reference · ${reference}`
  const dismiss = useCallback((restoreFocus = false) => {
    composing.current = false
    setOpen(false); setQuery(''); setActive(-1)
    if (restoreFocus) trigger.current?.focus({ preventScroll: true })
  }, [])
  useEffect(() => { dismiss() }, [enabled, scope, dismiss])
  const getItemKey = useCallback((index: number) => options[index]!.value ?? '', [options])
  const virtualizer = useVirtualizer({ count: open ? options.length : 0, getScrollElement: () => scroller.current,
    getItemKey, estimateSize: () => ROW_HEIGHT, overscan: 4, useFlushSync: false })
  const items = virtualizer.getVirtualItems()
  useLayoutEffect(() => {
    if (!open) return
    setActive(-1)
    virtualizer.scrollToOffset(0)
  }, [open, needle, virtualizer])
  useLayoutEffect(() => {
    const anchor = trigger.current, floating = panel.current
    if (!open || !anchor || !floating) return
    let disposed = false
    let focused = false
    const openingFocus = ownerDocument.activeElement
    const position = async () => {
      const result = await computePosition(anchor, floating, { strategy: 'fixed', placement: 'bottom-start', middleware: [
        offset(4), flip({ padding: 8 }), shift({ padding: 8 }), size({ padding: 8, apply({ availableWidth, availableHeight }) {
          Object.assign(floating.style, { width: `${Math.min(Math.max(anchor.getBoundingClientRect().width, 300), availableWidth)}px`, maxHeight: `${Math.min(400, availableHeight)}px` })
        } })
      ] })
      if (!disposed) {
        Object.assign(floating.style, { left: `${result.x}px`, top: `${result.y}px`, visibility: 'visible' })
        if (!focused && (ownerDocument.activeElement === openingFocus || floating.contains(ownerDocument.activeElement))) {
          focused = true
          input.current?.focus({ preventScroll: true })
        }
      }
    }
    const stop = autoUpdate(anchor, floating, () => { void position() })
    const outside = (event: Event) => {
      if (!anchor.contains(event.target as Node) && !floating.contains(event.target as Node)) dismiss()
    }
    ownerDocument.addEventListener('pointerdown', outside, true)
    ownerDocument.addEventListener('focusin', outside, true)
    return () => {
      disposed = true; stop()
      ownerDocument.removeEventListener('pointerdown', outside, true)
      ownerDocument.removeEventListener('focusin', outside, true)
    }
  }, [open, ownerDocument, dismiss])
  const choose = (index: number) => {
    const option = options[index]
    if (!enabled || !option || composing.current) return
    onSelect(option.value)
    dismiss(true)
  }
  const move = (index: number) => {
    if (!options.length) return
    const next = Math.max(0, Math.min(index, options.length - 1))
    setActive(next)
    virtualizer.scrollToIndex(next, { align: 'auto' })
  }
  return <>
    <button ref={trigger} type="button" className="selection-field git-history-ref-picker" aria-label="History reference"
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} data-value={reference ?? ''}
      title={title} onClick={() => open ? dismiss() : setOpen(true)} onKeyDown={event => {
        if (isImeOwnedKeyboardEvent(event) || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true) }
      }}>
      <span title={reference ? `Snapshot reference · ${reference}` : 'All local branches, remote-tracking references and HEAD in this snapshot; not just the checked-out branch.'}>{label}</span><ThemeNavigationDownIcon size={13} aria-hidden="true" />
    </button>
    {open && <WindowOverlayPortal><div ref={panel} id={id} role="dialog" aria-label="History references"
      className="tab-context-menu git-history-ref-picker__popover" style={{ visibility: 'hidden' }} onKeyDown={event => {
        if (isImeOwnedKeyboardEvent(event) || composing.current) { event.stopPropagation(); return }
        if (event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
          event.preventDefault(); event.stopPropagation(); dismiss(true)
        }
      }}>
      <div className="selection-field__search git-history-ref-picker__search">
        <TextInput ref={input} role="combobox" aria-label="Search history references" placeholder="Find a branch or reference…" autoComplete="off"
          aria-autocomplete="list" aria-expanded="true" aria-controls={listId} aria-describedby={id + '-count'}
          aria-activedescendant={items.some(item => item.index === active) ? `${listId}-${active}` : undefined}
          value={query} onChange={event => setQuery(event.currentTarget.value)}
          onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
          onKeyDown={event => {
            if (event.key === 'Escape') return
            event.stopPropagation()
            if (composing.current || isImeOwnedKeyboardEvent(event) || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault(); move(active < 0 ? event.key === 'ArrowDown' ? 0 : options.length - 1 : active + (event.key === 'ArrowDown' ? 1 : -1))
            } else if ((event.key === 'Home' || event.key === 'End') && active >= 0) {
              event.preventDefault(); move(event.key === 'Home' ? 0 : options.length - 1)
            } else if (event.key === 'Enter') { event.preventDefault(); choose(active) }
          }} />
        {query && <button type="button" className="selection-field__clear" aria-label="Clear reference search"
          onClick={() => { setQuery(''); input.current?.focus({ preventScroll: true }) }}><ThemeActionCloseIcon size={12} /></button>}
      </div>
      <div id={id + '-count'} className="git-history-ref-picker__count" role="status">{matches.length} / {available.length} snapshot references</div>
      {reference !== null && !selected && <p className="git-history-ref-picker__notice">Saved reference not in the current observation: <span>{reference}</span></p>}
      <div ref={scroller} id={listId} role="listbox" aria-label="History reference choices" className="git-history-ref-picker__results">
        <div className="git-history-ref-picker__window" style={{ height: virtualizer.getTotalSize() }}>
          {items.map(item => {
            const option = options[item.index]!
            return <button key={item.key} id={`${listId}-${item.index}`} type="button" role="option" tabIndex={-1}
              aria-selected={option.value === reference} aria-setsize={options.length} aria-posinset={item.index + 1}
              data-value={option.value ?? ''} data-active={active === item.index || undefined}
              className="git-history-ref-picker__option" title={option.description}
              style={{ height: ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
              onPointerDown={event => event.preventDefault()} onClick={event => {
                if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) choose(item.index)
              }}>
              <span className="git-history-ref-picker__kind">{option.kind}</span>
              <span className="git-history-ref-picker__name"><strong>{option.label}</strong><small>{option.description}</small></span>
              {option.value === reference && <span aria-hidden="true"><ThemeStatusSelectedIcon size={12} /></span>}
            </button>
          })}
        </div>
      </div>
      {!matches.length && <p className="git-history-ref-picker__notice">{needle ? 'No matching references.' : 'No observed references yet.'}</p>}
    </div></WindowOverlayPortal>}
  </>
})
