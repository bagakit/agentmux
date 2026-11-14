import { TextInput } from '@agentmux/client-ui/input'
import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom'
import { useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef, type Ref } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { BrowserInputHistorySnapshot, BrowserInputHistoryTarget } from '../../../shared/contracts'
import { api } from '../lib/api'
import { composerCompositionHandlers, composerRenderValue, type ComposerCompositionState } from '@agentmux/client-ui/composer-composition'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { WindowOverlayPortal } from './WindowOverlayHost'
import { browserAddressSuggestions } from '../lib/browser-address-suggestions'

const ThemeActionRemoveIcon = semanticIconComponent('action.remove')
const SearchIcon = semanticIconComponent('action.search')
const HistoryIcon = semanticIconComponent('object.history')
const BrowserIcon = semanticIconComponent('object.browser')


export type BrowserAddressInputHandle = { submit(text?: string): void; focus(): void }
type Props = Omit<ComponentPropsWithoutRef<typeof TextInput>, 'value' | 'onChange' | 'onSubmit' | 'onCompositionStart' | 'onCompositionUpdate' | 'onCompositionEnd'> & {
  value: string
  onValueChange(value: string): void
  onSubmit(value: string): void
  onHistoryNotice(notice: string | null): void
  onDeferredHistoryFailure(notice: string): void
  onHistoryChange?(): void
  historyTarget: BrowserInputHistoryTarget | null
  submitDisabled?: boolean
  ref?: Ref<BrowserAddressInputHandle>
}

/** One human-input consumer; navigation, Profile and durable history remain Main-owned. */
export function BrowserAddressInput({ value, onValueChange, onSubmit, onHistoryNotice, onDeferredHistoryFailure, onHistoryChange, historyTarget, submitDisabled = false, ref, onFocus, onBlur, onKeyDown, onContextMenu, onClick, onSelect, ...props }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const request = useRef(0)
  const currentTarget = historyTarget?.kind === 'browser' ? `browser:${historyTarget.browserId}:${historyTarget.profileId}` : historyTarget ? `workspace:${historyTarget.workspaceId}` : ''
  const targetKey = useRef(currentTarget)
  targetKey.current = currentTarget
  const [composition, setComposition] = useState<ComposerCompositionState>(null)
  const composing = useRef(false)
  const withdrawnSelection = useRef<{ key: string; value: string; start: number; end: number } | null>(null)
  const ime = composerCompositionHandlers({ state: composition, setState: setComposition, writeValue: onValueChange })
  const [loadedHistory, setLoadedHistory] = useState<{ key: string; snapshot: BrowserInputHistorySnapshot } | null>(null)
  const history = loadedHistory?.key === currentTarget ? loadedHistory.snapshot : null
  const [open, setOpen] = useState(false)
  const [filtering, setFiltering] = useState(false)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState(-1)
  const [notice, setNotice] = useState<string | null>(null)
  const [completion, setCompletion] = useState<{ key: string; prefix: string; text: string } | null>(null)
  const preview = open && completion?.key === currentTarget && completion.prefix === value ? completion : null
  const id = useId()
  useEffect(() => onHistoryNotice(notice), [notice, onHistoryNotice])
  // A current URL is context, not a query. Filter only once the person edits it.
  const entries = browserAddressSuggestions(history, value, filtering)
  const live = (key: string, token: number) => targetKey.current === key && request.current === token
  useLayoutEffect(() => {
    const node = input.current
    if (preview && node && node === document.activeElement) node.setSelectionRange(preview.prefix.length, preview.text.length)
    const selection = withdrawnSelection.current
    withdrawnSelection.current = null
    if (!preview && selection?.key === currentTarget && selection.value === value && node && node === document.activeElement) node.setSelectionRange(selection.start, selection.end)
  }, [preview, value, currentTarget])

  async function reload(): Promise<void> {
    const key = currentTarget, target = historyTarget, token = ++request.current
    if (!target) { setNotice('Input history is unavailable until its Workspace and Profile are confirmed. Browsing remains available.'); return }
    setLoading(true)
    try {
      const result = await api.browser.listInputHistory(target)
      if (!live(key, token)) return
      setLoadedHistory({ key, snapshot: result }); setSelected(-1); setCompletion(null); setNotice(result.warning ?? null)
    } catch (error) {
      if (live(key, token)) setNotice(`Input history could not be read: ${presentError(error)}. Your input and browsing remain available; retry history here.`)
    } finally { if (live(key, token)) setLoading(false) }
  }

  function submit(text = preview?.text ?? (open && selected >= 0 ? entries[selected]?.text ?? value : value)): void {
    if (props.disabled || submitDisabled || composing.current) return
    if (!text.trim()) { setOpen(false); onSubmit(text); return }
    if (text !== value) onValueChange(text)
    setOpen(false); setFiltering(false); setSelected(-1); setCompletion(null)
    const key = currentTarget, target = historyTarget, token = ++request.current
    if (target) {
      // Capture this human submission before navigation/creation; never read a later draft.
      void Promise.resolve().then(() => api.browser.recordInputHistory(target, text)).then(result => {
        if (targetKey.current === key && result.outcome === 'recorded') onHistoryChange?.()
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
  useImperativeHandle(ref, () => ({ submit, focus() { input.current?.focus(); input.current?.select() } }))

  useEffect(() => {
    ++request.current; setLoadedHistory(null); setOpen(false); setFiltering(false); setSelected(-1); setLoading(false); setNotice(null); setCompletion(null)
    return () => { ++request.current }
  }, [currentTarget])

  function dismiss(): void { ++request.current; setOpen(false); setLoading(false); setSelected(-1); setCompletion(null) }

  function showSuggestions(): void {
    if (composing.current) return
    setOpen(true)
    void reload()
  }

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
    setCompletion(null); setSelected(-1)
    try {
      const result = text === undefined ? await api.browser.clearInputHistory(target, snapshot.scope) : await api.browser.removeInputHistory(target, snapshot.scope, text)
      if (targetKey.current === key) onHistoryChange?.()
      if (live(key, token)) { setLoadedHistory({ key, snapshot: result }); setSelected(-1); setCompletion(null); setNotice(null) }
    } catch (error) {
      if (live(key, token)) setNotice(`Input history could not be deleted: ${presentError(error)}. Your input and saved history are kept; retry here.`)
    }
  }

  return <>
    <TextInput {...props} ref={input} role="combobox" aria-autocomplete="both" aria-description={open ? "Use arrow keys to choose. Shift+Delete removes the selected recent input." : undefined} aria-expanded={open} aria-controls={open ? id : undefined} aria-activedescendant={open && selected >= 0 && entries[selected] ? `${id}-${selected}` : undefined}
      value={composerRenderValue(preview?.text ?? value, composition)} autoComplete="off"
      onChange={event => {
        const next = event.currentTarget.value, native = event.nativeEvent as InputEvent
        setCompletion(null); setSelected(-1); setFiltering(true); ime.change(next)
        const candidates = native.inputType === 'insertText' && !composing.current && !native.isComposing && next.length > value.length && next.startsWith(value) &&
          event.currentTarget.selectionStart === next.length && event.currentTarget.selectionEnd === next.length
          ? browserAddressSuggestions(history, next, true) : []
        const index = candidates.findIndex(row => row.source === 'history' && row.text.length > next.length && row.text.toLocaleLowerCase().startsWith(next.toLocaleLowerCase()))
        if (index >= 0) { setCompletion({ key: currentTarget, prefix: next, text: candidates[index]!.text }); setSelected(index) }
        if (!open) showSuggestions()
      }}
      onCompositionStart={event => { composing.current = true; dismiss(); ime.compositionStart(preview ? value : event.currentTarget.value) }}
      onCompositionUpdate={event => ime.compositionUpdate(event.currentTarget.value)}
      onCompositionEnd={event => { composing.current = false; setFiltering(true); ime.compositionEnd(event.currentTarget.value) }}
      onFocus={onFocus}
      onClick={event => { onClick?.(event); if (!open) showSuggestions() }}
      onBlur={event => { onBlur?.(event); if (!panel.current?.contains(event.relatedTarget as Node)) dismiss() }}
      onSelect={event => {
        onSelect?.(event)
        if (preview && (event.currentTarget.selectionStart !== preview.prefix.length || event.currentTarget.selectionEnd !== preview.text.length)) {
          withdrawnSelection.current = { key: currentTarget, value, start: Math.min(event.currentTarget.selectionStart ?? 0, value.length), end: Math.min(event.currentTarget.selectionEnd ?? 0, value.length) }
          setCompletion(null)
        }
      }}
      onContextMenu={event => { event.stopPropagation(); dismiss(); onContextMenu?.(event) }}
      onKeyDown={event => {
        onKeyDown?.(event)
        if (event.defaultPrevented) return
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) { if (event.key === 'Enter') event.preventDefault(); return }
        if (event.key === 'Escape') { if (open) { event.preventDefault(); event.stopPropagation() }; dismiss(); return }
        if (event.key === 'Tab') { dismiss(); return }
        if (event.key === 'Delete' && event.shiftKey && open && selected >= 0 && entries[selected]?.source === 'history') {
          event.preventDefault(); void remove(entries[selected]!.text); return
        }
        if (preview && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (event.key === 'ArrowRight' || event.key === 'End')) {
          event.preventDefault(); onValueChange(preview.text); setCompletion(null); setSelected(-1)
          input.current?.setSelectionRange(preview.text.length, preview.text.length); return
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          setCompletion(null)
          if (!entries.length) { showSuggestions(); return }
          setOpen(true); setSelected(previous => previous < 0 ? event.key === 'ArrowDown' ? 0 : entries.length - 1 : (previous + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length); return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          const text = open && selected >= 0 ? entries[selected]?.text ?? value : value
          submit(text)
        }
      }} />
    {open ? <WindowOverlayPortal><div ref={panel} className="browser-address-history" role="dialog" aria-label="Browser input history" style={{ visibility: 'hidden' }}>
      <header><span>Addresses &amp; searches</span><button type="button" disabled={!history?.entries.length} onPointerDown={event => event.preventDefault()} onClick={() => void remove()}>Clear history</button></header>
      {notice ? <p role="status">{notice}<button type="button" onPointerDown={event => event.preventDefault()} onClick={() => { input.current?.focus(); void reload() }}>Retry history</button></p> : null}
      {loading ? <p>Reading input history…</p> : null}
      <ul id={id} role="listbox" aria-label="Recent addresses and searches">{entries.map((entry, index) => <li id={`${id}-${index}`} role="option" aria-selected={selected === index} key={entry.text}>
        <button type="button" className="browser-address-history__choose" aria-label={`${entry.source === 'history' ? 'Open recent input' : entry.kind === 'search' ? 'Search' : 'Open'} ${entry.text}`} title={entry.text}
          onPointerDown={event => event.preventDefault()} onClick={() => submit(entry.text)}>
          <span className="browser-address-history__icon" aria-hidden="true">{entry.faviconDataUrl ? <><BrowserIcon size={15} /><img key={entry.faviconDataUrl} src={entry.faviconDataUrl} alt="" onError={event => { event.currentTarget.hidden = true }} /></> : entry.kind === 'search' ? <SearchIcon size={15} /> : entry.kind === 'address' ? <BrowserIcon size={15} /> : <HistoryIcon size={15} />}</span>
          <span className="browser-address-history__text"><span><Matched text={entry.title} query={filtering ? value.trim() : ''} /></span><small><Matched text={entry.detail} query={filtering ? value.trim() : ''} /></small></span>
        </button>
        {entry.source === 'history' ? <button type="button" className="browser-address-history__delete" aria-label={`Remove input ${entry.text}`} onPointerDown={event => event.preventDefault()} onClick={() => void remove(entry.text)}><ThemeActionRemoveIcon size={12} /></button> : <span className="browser-address-history__action-space" />}
      </li>)}</ul>
      {!loading && !notice && (!history || !history.entries.length || !entries.length) ? <p>{!history ? 'Input history is not loaded.' : history.entries.length ? 'No matching recent input.' : 'No saved input yet.'}</p> : null}
    </div></WindowOverlayPortal> : null}
  </>
}

function Matched({ text, query }: { text: string; query: string }) {
  const index = query ? text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : -1
  return index < 0 ? <>{text}</> : <>{text.slice(0, index)}<mark>{text.slice(index, index + query.length)}</mark>{text.slice(index + query.length)}</>
}
