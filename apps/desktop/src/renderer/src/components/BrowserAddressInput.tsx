import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom'
import { useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef, type Ref } from 'react'
import { X } from 'lucide-react'
import type { BrowserInputHistorySnapshot, BrowserInputHistoryTarget } from '../../../shared/contracts'
import { api } from '../lib/api'
import { composerCompositionHandlers, composerRenderValue, type ComposerCompositionState } from '../lib/composer-composition'
import { presentError } from '../lib/error-presentation'
import { WindowOverlayPortal } from './WindowOverlayHost'

export type BrowserAddressInputHandle = { submit(): void }
type Props = Omit<ComponentPropsWithoutRef<'input'>, 'value' | 'onChange' | 'onSubmit' | 'onCompositionStart' | 'onCompositionUpdate' | 'onCompositionEnd'> & {
  value: string
  onValueChange(value: string): void
  onSubmit(value: string): void
  onHistoryNotice(notice: string | null): void
  onDeferredHistoryFailure(notice: string): void
  historyTarget: BrowserInputHistoryTarget | null
  submitDisabled?: boolean
  ref?: Ref<BrowserAddressInputHandle>
}

/** One human-input consumer; navigation, Profile and durable history remain Main-owned. */
export function BrowserAddressInput({ value, onValueChange, onSubmit, onHistoryNotice, onDeferredHistoryFailure, historyTarget, submitDisabled = false, ref, onFocus, onBlur, onKeyDown, onContextMenu, ...props }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const request = useRef(0)
  const currentTarget = historyTarget?.kind === 'browser' ? `browser:${historyTarget.browserId}:${historyTarget.profileId}` : historyTarget ? `workspace:${historyTarget.workspaceId}` : ''
  const targetKey = useRef(currentTarget)
  targetKey.current = currentTarget
  const [composition, setComposition] = useState<ComposerCompositionState>(null)
  const composing = useRef(false)
  const ime = composerCompositionHandlers({ state: composition, setState: setComposition, writeValue: onValueChange })
  const [loadedHistory, setLoadedHistory] = useState<{ key: string; snapshot: BrowserInputHistorySnapshot } | null>(null)
  const history = loadedHistory?.key === currentTarget ? loadedHistory.snapshot : null
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState(-1)
  const [notice, setNotice] = useState<string | null>(null)
  const id = useId()
  useEffect(() => onHistoryNotice(notice), [notice, onHistoryNotice])
  const entries = history?.entries.filter(entry => !value.trim() || entry.text.toLocaleLowerCase().includes(value.trim().toLocaleLowerCase())).slice(0, 8) ?? []
  const live = (key: string, token: number) => targetKey.current === key && request.current === token

  async function reload(): Promise<void> {
    const key = currentTarget, target = historyTarget, token = ++request.current
    if (!target) { setNotice('Input history is unavailable until its Workspace and Profile are confirmed. Browsing remains available.'); return }
    setLoading(true)
    try {
      const result = await api.browser.listInputHistory(target)
      if (!live(key, token)) return
      setLoadedHistory({ key, snapshot: result }); setSelected(-1); setNotice(null)
      if (document.activeElement === input.current && !composing.current) setOpen(true)
    } catch (error) {
      if (live(key, token)) setNotice(`Input history could not be read: ${presentError(error)}. Your input and browsing remain available; retry history here.`)
    } finally { if (live(key, token)) setLoading(false) }
  }

  function submit(text = value): void {
    if (props.disabled || submitDisabled || composing.current) return
    if (!text.trim()) { setOpen(false); onSubmit(text); return }
    setOpen(false); setSelected(-1)
    const key = currentTarget, target = historyTarget, token = ++request.current
    if (target) {
      // Capture this human submission before navigation/creation; never read a later draft.
      void Promise.resolve().then(() => api.browser.recordInputHistory(target, text)).then(result => {
        if (!live(key, token)) return
        setLoadedHistory({ key, snapshot: result })
        setNotice(result.outcome === 'url-userinfo' ? 'An address containing login information was not saved to input history.' : null)
      }).catch(error => {
        const message = `Input history could not be saved: ${presentError(error)}. Browsing continues; retry history here.`
        if (live(key, token)) setNotice(message)
        else onDeferredHistoryFailure(message)
      })
    } else setNotice('Input history cannot be saved until its Workspace and Profile are confirmed. Browsing continues.')
    onSubmit(text)
  }
  useImperativeHandle(ref, () => ({ submit }), [value, currentTarget, props.disabled, submitDisabled, historyTarget, onSubmit, onDeferredHistoryFailure])

  useEffect(() => {
    ++request.current; setLoadedHistory(null); setOpen(false); setSelected(-1); setLoading(false); setNotice(null)
    return () => { ++request.current }
  }, [currentTarget])

  function dismiss(): void { ++request.current; setOpen(false); setLoading(false); setSelected(-1) }

  useLayoutEffect(() => {
    const anchor = input.current, floating = panel.current
    if (!open || !anchor || !floating) return
    let disposed = false
    const position = async () => {
      const result = await computePosition(anchor, floating, { strategy: 'fixed', placement: 'bottom-start', middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 }), size({ padding: 8, apply({ availableWidth, availableHeight }) {
        Object.assign(floating.style, { width: `${Math.min(Math.max(anchor.getBoundingClientRect().width, 240), availableWidth)}px`, maxHeight: `${Math.min(280, availableHeight)}px` })
      } })] })
      if (!disposed) Object.assign(floating.style, { left: `${result.x}px`, top: `${result.y}px`, visibility: 'visible' })
    }
    const stop = autoUpdate(anchor, floating, () => { void position() })
    const outside = (event: Event) => { if (!anchor.contains(event.target as Node) && !floating.contains(event.target as Node)) dismiss() }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside, true)
    return () => { disposed = true; stop(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('focusin', outside, true) }
  }, [open])

  async function remove(text?: string): Promise<void> {
    const target = historyTarget, snapshot = history, key = currentTarget, token = ++request.current
    if (!target || !snapshot) return
    try {
      const result = text === undefined ? await api.browser.clearInputHistory(target, snapshot.scope) : await api.browser.removeInputHistory(target, snapshot.scope, text)
      if (live(key, token)) { setLoadedHistory({ key, snapshot: result }); setSelected(-1); setNotice(null) }
    } catch (error) {
      if (live(key, token)) setNotice(`Input history could not be deleted: ${presentError(error)}. Your input and saved history are kept; retry here.`)
    }
  }

  return <>
    <input {...props} ref={input} role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={open ? id : undefined} aria-activedescendant={open && selected >= 0 && entries[selected] ? `${id}-${selected}` : undefined}
      value={composerRenderValue(value, composition)} autoComplete="off"
      onChange={event => { setSelected(-1); ime.change(event.currentTarget.value); if (!composing.current) setOpen(true) }}
      onCompositionStart={event => { composing.current = true; dismiss(); ime.compositionStart(event.currentTarget.value) }}
      onCompositionUpdate={event => ime.compositionUpdate(event.currentTarget.value)}
      onCompositionEnd={event => { composing.current = false; ime.compositionEnd(event.currentTarget.value) }}
      onFocus={event => { onFocus?.(event); void reload() }}
      onBlur={event => { onBlur?.(event); if (!panel.current?.contains(event.relatedTarget as Node)) dismiss() }}
      onContextMenu={event => { event.stopPropagation(); dismiss(); onContextMenu?.(event) }}
      onKeyDown={event => {
        onKeyDown?.(event)
        if (event.defaultPrevented) return
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) { if (event.key === 'Enter') event.preventDefault(); return }
        if (event.key === 'Escape') { if (open) { event.preventDefault(); event.stopPropagation() }; dismiss(); return }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          if (!entries.length) { void reload(); return }
          event.preventDefault(); setOpen(true); setSelected(previous => previous < 0 ? event.key === 'ArrowDown' ? 0 : entries.length - 1 : (previous + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length); return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          const text = open && selected >= 0 ? entries[selected]?.text ?? value : value
          if (text !== value) onValueChange(text)
          submit(text)
        }
      }} />
    {open ? <WindowOverlayPortal><div ref={panel} className="browser-address-history" role="dialog" aria-label="Browser input history" style={{ visibility: 'hidden' }}>
      <header><span>Recent input</span><button type="button" disabled={!history?.entries.length} onClick={() => void remove()}>Clear</button></header>
      {notice ? <p role="status">{notice}<button type="button" onClick={() => void reload()}>Retry history</button></p> : null}
      {loading ? <p>Reading input history…</p> : null}
      <ul id={id} role="listbox" aria-label="Recent addresses and searches">{entries.map((entry, index) => <li id={`${id}-${index}`} role="option" aria-selected={selected === index} key={entry.text}>
        <button type="button" className="browser-address-history__choose" onPointerDown={event => event.preventDefault()} onClick={() => { onValueChange(entry.text); submit(entry.text) }}>{entry.text}</button>
        <button type="button" className="browser-address-history__delete" aria-label={`Remove input ${entry.text}`} onPointerDown={event => event.preventDefault()} onClick={() => void remove(entry.text)}><X size={12} /></button>
      </li>)}</ul>
      {!loading && entries.length === 0 ? <p>{!history ? 'Input history is not loaded.' : history.entries.length ? 'No matching recent input.' : 'No saved input yet.'}</p> : null}
    </div></WindowOverlayPortal> : null}
  </>
}
