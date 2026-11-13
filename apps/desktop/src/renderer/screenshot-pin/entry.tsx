import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { Copy, Download, GripVertical, MousePointerClick, PointerOff, X } from 'lucide-react'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import { mintObjectId } from '@agentmux/core/object-id'
import type { ScreenshotPinApi, ScreenshotPinInput } from '../../shared/screenshot-pin'
import './pin.css'

const api = (window as unknown as { screenshotPin: ScreenshotPinApi }).screenshotPin
const OPACITY_STEPS = [1, 0.8, 0.6, 0.4]
type Notice = { text: string; failed: boolean }

function PinView({ input }: { input: ScreenshotPinInput }) {
  const id = input.pinId, logical = input.logicalScale > 1
  const [notice, setNotice] = useState<Notice | null>(input.theme.status === 'unavailable' ? { text: input.theme.message, failed: true } : null)
  const [busy, setBusy] = useState(false), [opacity, setOpacity] = useState(1), [clickThrough, setClickThrough] = useState(false)
  const passThrough = useRef(false)
  const report = (error: unknown) => setNotice({ text: error instanceof Error ? error.message : String(error), failed: true })
  // A lasting success notice would cover part of the reference, so it clears; failures stay until the next action.
  useEffect(() => {
    if (!notice || notice.failed) return
    const timer = setTimeout(() => setNotice(null), 1800)
    return () => clearTimeout(timer)
  }, [notice])

  async function output(kind: 'copy' | 'save' | 'save-1x') {
    if (busy) return
    setBusy(true); setNotice(null)
    try {
      const result = kind === 'copy' ? await api.copy(id, mintObjectId()) : await api.save(id, mintObjectId(), kind === 'save-1x' ? { logicalSize: true } : undefined)
      if (result.status === 'completed') setNotice({ text: 'PNG copied', failed: false })
      else if (result.status === 'saved') setNotice({ text: 'Saved · ' + result.path.split('/').at(-1), failed: false })
      else if (result.status !== 'cancelled') report(result.message)
    } catch (error) { report(error) } finally { setBusy(false) }
  }
  const close = () => void api.close(id).catch(report)
  async function cycleOpacity() {
    const next = OPACITY_STEPS[(OPACITY_STEPS.indexOf(opacity) + 1) % OPACITY_STEPS.length]!
    try { await api.opacity(id, next); setOpacity(next) } catch (error) { report(error) }
  }
  async function setPassThrough(enabled: boolean) {
    passThrough.current = enabled
    try { await api.clickThrough(id, enabled); setClickThrough(enabled) } catch (error) { passThrough.current = !enabled; report(error) }
  }
  function move(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return
    const handle = event.currentTarget, start = { x: event.screenX, y: event.screenY, left: window.screenX, top: window.screenY }
    handle.setPointerCapture(event.pointerId)
    const follow = (next: PointerEvent) => void api.move(id, { x: start.left + next.screenX - start.x, y: start.top + next.screenY - start.y }).catch(report)
    const end = () => { handle.removeEventListener('pointermove', follow); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end) }
    handle.addEventListener('pointermove', follow); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end)
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey, letter = event.key.toLowerCase()
      if (event.key === 'Escape' || (command && letter === 'w')) { event.preventDefault(); close() }
      else if (command && letter === 'c') { event.preventDefault(); void output('copy') }
      else if (command && letter === 's') { event.preventDefault(); void output(event.shiftKey && logical ? 'save-1x' : 'save') }
    }
    // Wheel and trackpad pinch resize the window around the pointer; pinch arrives as ctrl+wheel.
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      void api.zoom(id, Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002)), { x: event.clientX, y: event.clientY }).catch(report)
    }
    window.addEventListener('keydown', key); window.addEventListener('wheel', wheel, { passive: false })
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('wheel', wheel) }
  }, [busy])

  return <main className="screenshot-pin" data-click-through={clickThrough || undefined}>
    <img src={input.image.dataUrl} alt="Pinned screenshot" draggable onDragStart={event => { event.preventDefault(); void api.drag(id).catch(report) }} />
    <nav className="screenshot-pin__controls" aria-label="Pinned image actions">
      <button className="screenshot-pin__grip" aria-label="Move pinned image" title="Move" onPointerDown={move}><GripVertical aria-hidden /></button>
      <button className="screenshot-pin__primary" aria-label="Copy" title="Copy PNG  ⌘C" disabled={busy} onClick={() => void output('copy')}><Copy aria-hidden /></button>
      <button aria-label="Save PNG" title="Save PNG  ⌘S" disabled={busy} onClick={() => void output('save')}><Download aria-hidden /></button>
      {logical && <button className="screenshot-pin__text" aria-label="Save PNG at 1×" title="Save PNG at 1×  ⇧⌘S" disabled={busy} onClick={() => void output('save-1x')}>1×</button>}
      <button className="screenshot-pin__text" aria-label="Opacity" title="Opacity" onClick={() => void cycleOpacity()}>{Math.round(opacity * 100)}%</button>
      <button aria-label="Click-through" title="Let clicks pass through" onClick={() => void setPassThrough(true)}><PointerOff aria-hidden /></button>
      <button aria-label="Close" title="Close  Esc" onClick={close}><X aria-hidden /></button>
    </nav>
    {clickThrough && <button className="screenshot-pin__restore" aria-label="Stop click-through" title="Click to stop click-through"
      // While the pointer is on this handle the window takes clicks again, so the handle stays reachable.
      onPointerEnter={() => void api.clickThrough(id, false).catch(report)}
      onPointerLeave={() => { if (passThrough.current) void api.clickThrough(id, true).catch(report) }}
      onClick={() => void setPassThrough(false)}><MousePointerClick aria-hidden /></button>}
    {notice && <output className="screenshot-pin__notice" role={notice.failed ? 'alert' : 'status'} data-failed={notice.failed || undefined}
      onClick={() => setNotice(null)}>{notice.text}</output>}
  </main>
}
void api.load().then(input => {
  mountThemeRuntime(window, input.theme.status === 'available' ? { kind: 'observed', document: input.theme.document, appearance: input.theme.appearance } : {})
  createRoot(document.getElementById('root')!).render(<PinView input={input} />)
}).catch(error => { document.getElementById('root')!.textContent = String(error) })
