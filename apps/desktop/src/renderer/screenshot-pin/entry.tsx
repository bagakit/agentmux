import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import { mintObjectId } from '@agentmux/core/object-id'
import type { ScreenshotPinApi, ScreenshotPinInput } from '../../shared/screenshot-pin'
import './pin.css'

const api = (window as unknown as { screenshotPin: ScreenshotPinApi }).screenshotPin
function PinView({ input }: { input: ScreenshotPinInput }) {
  const [message, setMessage] = useState(input.theme.status === 'unavailable' ? input.theme.message : 'Temporary reference'), [busy, setBusy] = useState(false), [failed, setFailed] = useState(false)
  const header = useRef<HTMLElement>(null), footer = useRef<HTMLElement>(null)
  useEffect(() => {
    let frame = 0
    const measure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const height = (header.current?.getBoundingClientRect().height ?? 0) + (footer.current?.getBoundingClientRect().height ?? 0)
        void api.layout(input.pinId, height).catch(error => { setMessage(String(error)); setFailed(true) })
      })
    }
    const observer = new ResizeObserver(measure)
    if (header.current) observer.observe(header.current)
    if (footer.current) observer.observe(footer.current)
    window.addEventListener('resize', measure); measure()
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); cancelAnimationFrame(frame) }
  }, [input.pinId])
  async function close() { try { await api.close(input.pinId) } catch (error) { setMessage(String(error)); setFailed(true) } }
  async function output(kind: 'copy' | 'save') {
    if (busy) return
    setBusy(true); setFailed(false)
    try {
      const result = await api[kind](input.pinId, mintObjectId())
      if (result.status === 'completed') setMessage('PNG copied')
      else if (result.status === 'saved') setMessage('PNG saved · ' + result.path)
      else if (result.status !== 'cancelled') { setMessage(result.message); setFailed(true) }
    } catch (error) { setMessage(String(error)); setFailed(true) }
    finally { setBusy(false) }
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w')) { event.preventDefault(); void close() }
      else if ((event.metaKey || event.ctrlKey) && ['c', 's'].includes(event.key.toLowerCase())) { event.preventDefault(); void output(event.key.toLowerCase() === 'c' ? 'copy' : 'save') }
    }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key)
  }, [busy])
  return <main className="screenshot-pin">
    <header ref={header}><span className="screenshot-pin__label">Pinned <small>{input.image.width} × {input.image.height}</small></span>
      <nav aria-label="Pinned image actions"><button disabled={busy} onClick={() => void output('copy')}>Copy</button><button disabled={busy} onClick={() => void output('save')}>Save PNG</button><button aria-label="Close pinned image" onClick={() => void close()}>Close</button></nav>
    </header>
    <div className="screenshot-pin__image"><img src={input.image.dataUrl} alt="Pinned processed screenshot" draggable={false} /></div>
    <footer ref={footer} role={failed ? 'alert' : 'status'}>{message}</footer>
  </main>
}
void api.load().then(input => {
  mountThemeRuntime(window, input.theme.status === 'available' ? { kind: 'observed', document: input.theme.document, appearance: input.theme.appearance } : {})
  createRoot(document.getElementById('root')!).render(<PinView input={input} />)
}).catch(error => { document.getElementById('root')!.textContent = String(error) })
