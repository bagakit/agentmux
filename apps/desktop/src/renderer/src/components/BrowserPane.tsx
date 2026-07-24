import { AlertTriangle, ArrowLeft, ArrowRight, Globe2, LoaderCircle, RefreshCw } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BrowserSnapshot } from '../../../shared/contracts'
import { api } from '../lib/api'
import type { BrowserWorkbenchTab } from '../lib/workbench-tabs'
import { useAppStore } from '../store'

export function BrowserPane({ tab, visible }: { tab: BrowserWorkbenchTab; visible: boolean }) {
  const applyBrowserEvent = useAppStore((state) => state.applyBrowserEvent)
  const reportError = useAppStore((state) => state.reportError)
  const toolsOpen = useAppStore((state) => state.toolsOpen)
  const stageRef = useRef<HTMLDivElement>(null)
  const [address, setAddress] = useState(tab.url === 'about:blank' ? '' : tab.url)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setAddress(tab.url === 'about:blank' ? '' : tab.url)
  }, [tab.url])

  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    let frame = 0
    const update = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const navigatorCoversBrowser = toolsOpen && window.innerWidth <= 900
        if (!visible || navigatorCoversBrowser || __AGENTMUX_WEB_PREVIEW__ || tab.error || tab.url === 'about:blank') {
          void api.browser.setBounds(tab.browserId, null)
          return
        }
        const rect = stage.getBoundingClientRect()
        void api.browser.setBounds(tab.browserId, {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        }).catch(reportError)
      })
    }
    const observer = new ResizeObserver(update)
    observer.observe(stage)
    window.addEventListener('resize', update)
    update()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', update)
      void api.browser.setBounds(tab.browserId, null).catch(() => {})
    }
  }, [toolsOpen, reportError, tab.browserId, tab.error, tab.url, visible])

  async function run(action: () => Promise<BrowserSnapshot>): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      const browser = await action()
      applyBrowserEvent({ type: 'updated', browser })
    } catch (error) {
      reportError(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="browser-surface">
      <form
        className="browser-toolbar"
        onSubmit={(event) => {
          event.preventDefault()
          if (address.trim()) void run(() => api.browser.navigate(tab.browserId, address.trim()))
        }}
      >
        <button type="button" title="Back" disabled={!tab.canGoBack || busy} onClick={() => void run(() => api.browser.back(tab.browserId))}><ArrowLeft size={13} /></button>
        <button type="button" title="Forward" disabled={!tab.canGoForward || busy} onClick={() => void run(() => api.browser.forward(tab.browserId))}><ArrowRight size={13} /></button>
        <button type="button" title="Reload" disabled={busy} onClick={() => void run(() => api.browser.reload(tab.browserId))}>
          {tab.loading || busy ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
        </button>
        <label>
          <Globe2 size={13} />
          <input
            aria-label="Browser address"
            value={address}
            placeholder="Search or enter an address"
            onChange={(event) => setAddress(event.target.value)}
          />
        </label>
      </form>
      <div className="browser-stage" ref={stageRef}>
        {tab.error ? (
          <div className="pane-state pane-state--error">
            <AlertTriangle size={20} />
            <strong>Page could not be loaded</strong>
            <span>{tab.error}</span>
            <button className="small-button" type="button" onClick={() => void run(() => api.browser.reload(tab.browserId))}><RefreshCw size={12} /> Retry</button>
          </div>
        ) : tab.url === 'about:blank' ? (
          <div className="browser-empty"><Globe2 size={25} /><strong>New browser tab</strong><span>Enter an address above. Electron Main will mount a native WebContentsView.</span></div>
        ) : __AGENTMUX_WEB_PREVIEW__ ? (
          <div className="browser-preview"><Globe2 size={25} /><strong>{tab.title || tab.url}</strong><span>{tab.url}</span><small>Web Preview represents the Main-owned WebContentsView here.</small></div>
        ) : null}
      </div>
    </section>
  )
}
