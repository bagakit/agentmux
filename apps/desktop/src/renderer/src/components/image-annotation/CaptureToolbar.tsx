import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { RovingToolbar, RovingToolbarButton } from '@agentmux/client-ui/components/RovingToolbar'
import { ANNOTATION_TOOLS, type AnnotationTool } from './AnnotationToolbar'

const icon = semanticIconComponent
const PinIcon = icon('action.pin'), SaveIcon = icon('action.save'), ExpandIcon = icon('layout.expand'), CloseIcon = icon('action.close')
/** The marks a capture selection offers, in toolbar order; labels, icons and keys are the shared editor's. */
export const CAPTURE_TOOLS = (['rect', 'ellipse', 'arrow', 'pen', 'wand', 'pixelate', 'blur', 'text', 'note', 'callout'] as const).map(id => ANNOTATION_TOOLS.find(item => item.id === id)!)

export function CaptureToolbar({ tool, busy, loaded, label, discard, onTool, onPin, onSavePng, onExpand, onCancel, onComplete }: {
  tool: AnnotationTool; busy: boolean; loaded: boolean
  /** The primary delivery's visible name. */
  label: string
  /** The in-place discard confirmation, shown instead of Cancel. */
  discard: ReactNode
  onTool(tool: AnnotationTool): void; onPin(): void; onSavePng(): void; onExpand(): void; onCancel(): void; onComplete(): void
}) {
  const divider = <span className="image-annotation-capture-toolbar__divider" aria-hidden="true" />
  return <RovingToolbar className="image-annotation-capture-toolbar" aria-label="Capture tools">
    {/* Pressing the current mark again returns to adjusting the selection. */}
    <div className="image-annotation-capture-toolbar__group" role="group" aria-label="Marks">{CAPTURE_TOOLS.map(item => <RovingToolbarButton key={item.id} type="button"
      aria-label={item.label} data-capture-hint={item.label + ' (' + item.key + ')'} aria-keyshortcuts={item.key} aria-pressed={tool === item.id} disabled={busy}
      onClick={() => onTool(tool === item.id ? 'select' : item.id)}><item.icon size={15} /></RovingToolbarButton>)}</div>
    {divider}
    <div className="image-annotation-capture-toolbar__group" role="group" aria-label="Output">
      <RovingToolbarButton type="button" aria-label="Pin image" data-capture-hint="Pin (⌘P)" aria-keyshortcuts="Meta+P" disabled={busy || !loaded} onClick={onPin}><PinIcon size={15} /></RovingToolbarButton>
      <RovingToolbarButton type="button" aria-label="Save PNG" data-capture-hint="Save PNG (⌘S)" aria-keyshortcuts="Meta+S" disabled={busy || !loaded} onClick={onSavePng}><SaveIcon size={15} /></RovingToolbarButton>
    </div>
    {divider}
    <RovingToolbarButton type="button" aria-label="Expand editor" data-capture-hint="Expand editor (⌘E)" aria-keyshortcuts="Meta+E" disabled={busy} onClick={onExpand}><ExpandIcon size={14} /></RovingToolbarButton>
    {divider}
    {discard ?? <RovingToolbarButton type="button" aria-label="Cancel" data-capture-hint="Cancel (Esc)" aria-keyshortcuts="Escape" onClick={onCancel}><CloseIcon size={14} /></RovingToolbarButton>}
    <RovingToolbarButton type="button" className="primary-button" aria-label={label} data-capture-hint={label + ' (↵)'} aria-keyshortcuts="Enter" disabled={busy || !loaded} onClick={onComplete}>
      {label}<kbd aria-hidden="true">↵</kbd>
    </RovingToolbarButton>
  </RovingToolbar>
}

/** The one line a capture shows before its selection exists, with the Cancel entry the toolbar carries afterwards. */
export function CaptureHint({ text, onCancel }: { text: string; onCancel(): void }) {
  return <div className="image-annotation-editor__capture-hint">
    <span>{text}</span>
    <button type="button" aria-label="Cancel" data-capture-hint="Cancel (Esc)" aria-keyshortcuts="Escape" onClick={onCancel}><CloseIcon size={14} /></button>
  </div>
}

/** Chromium can draw title hints in a separate native window. Keep every capture hint inside the excluded display overlay. */
export function CaptureTooltip() {
  const tip = useRef<HTMLSpanElement>(null), id = useId()
  useEffect(() => {
    const panel = tip.current!, surface = panel.parentElement!
    let anchor: HTMLElement | null = null
    let stop: (() => void) | undefined
    function show(target: EventTarget | null) {
      const next = target instanceof Element ? target.closest<HTMLElement>('[data-capture-hint]') : null
      if (next === anchor) return
      stop?.()
      anchor?.removeAttribute('aria-describedby')
      anchor = next
      panel.hidden = true
      if (!anchor) return
      const active = anchor
      active.setAttribute('aria-describedby', id)
      panel.textContent = active.dataset.captureHint!
      panel.style.visibility = 'hidden'
      panel.hidden = false
      stop = autoUpdate(active, panel, () => {
        if (!active.isConnected) { show(null); return }
        void computePosition(active, panel, { strategy: 'fixed', placement: 'top',
          middleware: [offset(6), flip(), shift({ padding: 6 })] }).then(({ x, y }) => {
          if (anchor === active) Object.assign(panel.style, { left: x + 'px', top: y + 'px', visibility: 'visible' })
        })
      })
    }
    const enter = (event: PointerEvent) => show(event.target)
    const focus = (event: FocusEvent) => { if (event.target instanceof Element && event.target.matches(':focus-visible')) show(event.target) }
    const clear = () => show(null)
    surface.addEventListener('pointerover', enter)
    surface.addEventListener('pointerleave', clear)
    surface.addEventListener('pointerdown', clear)
    surface.addEventListener('focusin', focus)
    surface.addEventListener('focusout', clear)
    return () => {
      clear()
      surface.removeEventListener('pointerover', enter)
      surface.removeEventListener('pointerleave', clear)
      surface.removeEventListener('pointerdown', clear)
      surface.removeEventListener('focusin', focus)
      surface.removeEventListener('focusout', clear)
    }
  }, [id])
  return <span ref={tip} id={id} role="tooltip" className="image-annotation-editor__capture-tooltip" hidden />
}
