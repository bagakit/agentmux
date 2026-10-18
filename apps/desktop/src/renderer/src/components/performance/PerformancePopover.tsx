import { createContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom'
import { markWindowOverlayDismissal, WindowOverlayPortal } from '../WindowOverlayHost'

export const ToolkitPopoverSurface = createContext<{
  panel: RefObject<HTMLDivElement | null>
  setResizable(value: boolean): void
} | null>(null)

/** 原生焦点顺序；只负责本浮窗的进入与退出，不持有资源观察事实。 */
export type ToolkitPopoverSelection = { selectedToolId: string | symbol | null; onSelectTool(toolId: string | symbol | null, closingToolId?: string | symbol): void }

export function ToolkitPopover({ children, label = false, onVisibleChange, focusKey, toolId, name, icon, selectedToolId, onSelectTool }: ToolkitPopoverSelection & {
  toolId: string | symbol; name: string; icon: ReactNode
  children(close: () => void): ReactNode
  label?: boolean
  onVisibleChange?(visible: boolean): void
  focusKey?: string
}) {
  const open = selectedToolId === toolId
  const setOpen = (next: boolean) => onSelectTool(next ? toolId : null, next ? undefined : toolId)
  const [visible, setVisible] = useState(() => !document.hidden)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [resizable, setResizable] = useState(false)
  const surface = useMemo(() => ({ panel, setResizable }), [])
  const origin = useRef<'hover' | 'explicit'>('hover')
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const cancel = () => { clearTimeout(openTimer.current); clearTimeout(closeTimer.current) }
  const close = (restoreFocus = true) => {
    cancel()
    const restore = restoreFocus && origin.current === 'explicit' && panel.current?.contains(document.activeElement)
    setOpen(false)
    if (restore) trigger.current?.focus({ preventScroll: true })
  }
  const enter = () => {
    clearTimeout(closeTimer.current)
    if (!open) openTimer.current = setTimeout(() => {
      if (document.activeElement instanceof HTMLElement && document.activeElement.closest('.performance-popover')) return
      origin.current = 'hover'; setOpen(true)
    }, 120)
  }
  const leave = () => {
    clearTimeout(openTimer.current)
    if (origin.current === 'hover' && !panel.current?.contains(document.activeElement))
      closeTimer.current = setTimeout(close, 180)
  }
  const promote = () => {
    cancel(); origin.current = 'explicit'; setOpen(true)
    if (open) panel.current?.querySelector<HTMLButtonElement>('[data-toolkit-close]')?.focus({ preventScroll: true })
  }
  useEffect(() => { if (selectedToolId !== toolId) cancel() }, [selectedToolId, toolId])
  useEffect(() => {
    if (!open) { cancel(); return }
    const changed = () => { cancel(); setVisible(!document.hidden) }
    changed()
    document.addEventListener('visibilitychange', changed)
    return () => { cancel(); document.removeEventListener('visibilitychange', changed) }
  }, [open])
  useEffect(() => { onVisibleChange?.(open && visible); return () => onVisibleChange?.(false) }, [open, visible, onVisibleChange])
  useLayoutEffect(() => {
    if (open && visible && origin.current === 'explicit') panel.current?.querySelector<HTMLButtonElement>('[data-toolkit-close]')?.focus({ preventScroll: true })
  }, [focusKey])
  useLayoutEffect(() => {
    const a = trigger.current, b = panel.current
    if (!open || !visible || !a || !b) return
    let connected = true, placed = false
    const update = async () => {
      const { x, y } = await computePosition(a, b, { strategy: 'fixed', placement: resizable ? 'top-end' : 'top-start', middleware: [offset(8),
        // Size before shift: available space is measured from this trailing anchor.
        ...(resizable ? [size({ padding: 12, apply({ availableWidth, availableHeight }) {
          if (!connected) return
          b.style.setProperty('--toolkit-available-width', `${Math.max(0, availableWidth)}px`)
          b.style.setProperty('--toolkit-available-height', `${Math.max(0, availableHeight)}px`)
        } })] : []), flip(), shift({ padding: 12 })] })
      if (!connected) return
      Object.assign(b.style, { left: `${x}px`, top: `${y}px`, visibility: 'visible' })
      if (!placed && origin.current === 'explicit') b.querySelector<HTMLButtonElement>('[data-toolkit-close]')?.focus({ preventScroll: true })
      placed = true
    }
    const stop = autoUpdate(a, b, update)
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !a.contains(event.target) && !b.contains(event.target)) close(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return
      const menu = event.target instanceof Element ? event.target.closest('[data-toolkit-menu]') : null
      if (menu && b.contains(menu)) { markWindowOverlayDismissal(event); return }
      const terminal = event.target instanceof Element ? event.target.closest('[data-toolkit-terminal]') : null
      if (terminal && b.contains(terminal) && terminal.contains(document.activeElement)) return
      // A focused local reader consumes its first Escape before the floating owner closes.
      const local = event.target instanceof Element ? event.target.closest('[data-toolkit-local-escape]') : null
      if (local && b.contains(local) && local === document.activeElement) return
      // A passive reader closes without consuming the focused input owner's cancellation.
      if (origin.current === 'hover' && !b.contains(document.activeElement)) { markWindowOverlayDismissal(event); close(); return }
      // 可见浮窗拥有本次 Escape；capture 先于原 Settings 的关闭处理，IME 始终归原输入。
      event.preventDefault(); event.stopPropagation()
      close()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true)
    return () => {
      connected = false; stop(); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true)
      b.style.removeProperty('--toolkit-available-width'); b.style.removeProperty('--toolkit-available-height')
    }
  }, [open, visible, resizable])
  return <>
    <button ref={trigger} type="button" className="performance-trigger" aria-label={name} title={name} aria-expanded={open} data-toolkit-id={typeof toolId === 'string' ? toolId : undefined}
      aria-haspopup="dialog" onPointerEnter={enter} onPointerLeave={leave} onClick={promote}>
      {icon}{label ? <span>{name}</span> : null}
    </button>
    {open && visible ? <WindowOverlayPortal><div ref={panel} className="performance-popover" role="dialog" aria-label={name}
      style={{ visibility: 'hidden' }} onPointerEnter={() => clearTimeout(closeTimer.current)} onPointerLeave={leave}
      onPointerDownCapture={() => { cancel(); origin.current = 'explicit' }}
      onFocusCapture={() => { clearTimeout(closeTimer.current); origin.current = 'explicit' }}
      onKeyDown={event => {
        if (event.key === 'Escape' && event.target instanceof Element && event.target.closest('[data-toolkit-terminal]')) event.stopPropagation()
      }}>
      <ToolkitPopoverSurface.Provider value={surface}>{children(close)}</ToolkitPopoverSurface.Provider>
    </div></WindowOverlayPortal> : null}
  </>
}
