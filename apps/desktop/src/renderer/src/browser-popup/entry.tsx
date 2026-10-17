import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { semanticIconComponent, updateIconSprite } from '@agentmux/client-ui/icons'
import { resolveTheme } from '@agentmux/client-ui/theme'
import { projectInitialTheme } from '../../../preload/theme-bootstrap'
import type { BrowserPopupAPI, BrowserPopupCommand, BrowserPopupSnapshot } from '../../../shared/browser-popup-navigation'
import './popup.css'

const Back = semanticIconComponent('navigation.back')
const Forward = semanticIconComponent('navigation.forward')
const Reload = semanticIconComponent('action.refresh')
const Stop = semanticIconComponent('action.stop')
const Browser = semanticIconComponent('object.browser')
declare global { interface Window { browserPopup: BrowserPopupAPI } }
const popup = window.browserPopup
const base = resolveTheme()
updateIconSprite(document, base.value, base.variant.colors.text)

/** This document edits a draft; the exact native page remains the navigation owner. */
export function BrowserPopupNavigation() {
  const [state, setState] = useState<BrowserPopupSnapshot | null>(null)
  const [address, setAddress] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [remember, setRemember] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const chrome = useRef<HTMLDivElement>(null)
  const dirty = useRef(false)
  const editing = useRef(false)
  const draftRevision = useRef(0)
  const composing = useRef(false)
  const current = useRef(state)
  current.current = state
  const live = useRef(true)
  const accept = useCallback((snapshot: BrowserPopupSnapshot) => {
    if (!live.current) return
    setState(snapshot)
    if (!dirty.current && !editing.current) setAddress(snapshot.url)
  }, [])
  const command = useCallback(async (value: BrowserPopupCommand) => {
    try {
      const result = await popup.command(value)
      if (!live.current) return null
      accept(result)
      if (value.kind !== 'chrome-height') setLocalError(null)
      return result
    } catch (error) {
      if (live.current) setLocalError(error instanceof Error ? error.message : String(error))
      return null
    }
  }, [accept])

  useEffect(() => {
    live.current = true
    let received = false
    const changed = popup.onChanged(snapshot => { received = true; accept(snapshot) })
    const focus = popup.onFocusAddress(() => { input.current?.focus(); input.current?.select() })
    void popup.inspect().then(snapshot => { if (!received) accept(snapshot) }).catch(error => {
      if (live.current) setLocalError(error instanceof Error ? error.message : String(error))
    })
    return () => { live.current = false; changed(); focus() }
  }, [accept])
  useEffect(() => {
    const theme = state?.theme
    if (theme?.status !== 'available') return
    projectInitialTheme(theme)
    updateIconSprite(document, theme.document, theme.variables['--text'] ?? base.variant.colors.text)
  }, [state?.theme])
  useEffect(() => { setRemember(false) }, [state?.appLinkPrompt?.id])
  useEffect(() => {
    const node = chrome.current
    if (!node) return
    let height = 0
    const observer = new ResizeObserver(() => {
      const next = Math.ceil(node.getBoundingClientRect().height)
      if (height === next) return
      height = next
      void command({ kind: 'chrome-height', height: next })
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [command])

  async function navigate() {
    if (composing.current) return
    const revision = draftRevision.current
    const result = await command({ kind: 'navigate', address })
    if (result && draftRevision.current === revision) {
      dirty.current = false
      if (!editing.current) setAddress(result.url)
    }
  }
  const prompt = state?.appLinkPrompt
  const notice = localError || state?.error || state?.warning || (state?.theme?.status === 'unavailable' ? state.theme.message : null)
  return <div ref={chrome} className="popup-navigation">
    <form aria-label="Browser navigation" onSubmit={event => { event.preventDefault(); void navigate() }}>
      <button type="button" aria-label="Back" title="Back" disabled={!state?.canGoBack} onClick={() => void command({ kind: 'back' })}><Back size={15} /></button>
      <button type="button" aria-label="Forward" title="Forward" disabled={!state?.canGoForward} onClick={() => void command({ kind: 'forward' })}><Forward size={15} /></button>
      <button type="button" aria-label={state?.loading ? 'Stop loading' : 'Reload'} title={state?.loading ? 'Stop loading' : 'Reload'} onClick={() => void command({ kind: state?.loading ? 'stop' : 'reload' })}>{state?.loading ? <Stop size={13} /> : <Reload size={15} />}</button>
      <label className="address"><Browser size={14} />
        <input ref={input} aria-label="Browser address" placeholder="Search or enter an address" value={address} autoComplete="off" spellCheck={false}
          onFocus={event => { editing.current = true; event.currentTarget.select() }}
          onBlur={() => { editing.current = false; if (!dirty.current) setAddress(current.current?.url ?? '') }}
          onChange={event => { dirty.current = true; ++draftRevision.current; setAddress(event.currentTarget.value) }}
          onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
          onKeyDown={event => {
            if (event.key === 'Enter' && (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault()
            if (event.key === 'Escape' && !composing.current && !event.nativeEvent.isComposing) {
              event.preventDefault(); dirty.current = false; ++draftRevision.current; setAddress(current.current?.url ?? ''); event.currentTarget.select()
            }
          }} />
        {state?.mode === 'private' ? <span className="private" title="Temporary website session" aria-label="Private session">Private</span> : null}
      </label>
    </form>
    {notice ? <div className="notice error" role="status"><p>{notice}</p></div> : null}
    {prompt ? <div className="notice" role="group" aria-label="Open another app">
      <p>This page wants to open a <strong>{prompt.scheme}:</strong> link in another app.</p>
      <label><input type="checkbox" checked={remember} onChange={event => setRemember(event.currentTarget.checked)} />Remember</label>
      <button type="button" onClick={() => void command({ kind: 'answer-app-link', promptId: prompt.id, allow: false, remember })}>Cancel</button>
      <button type="button" className="primary" onClick={() => void command({ kind: 'answer-app-link', promptId: prompt.id, allow: true, remember })}>Open app</button>
    </div> : null}
  </div>
}

createRoot(document.getElementById('root')!).render(<BrowserPopupNavigation />)
