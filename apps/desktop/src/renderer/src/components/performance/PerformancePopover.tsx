import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'
import { markWindowOverlayDismissal, WindowOverlayPortal } from '../WindowOverlayHost'

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
      const { x, y } = await computePosition(a, b, { strategy: 'fixed', placement: 'top-start', middleware: [offset(8), flip(), shift({ padding: 12 })] })
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
      // A passive reader closes without consuming the focused input owner's cancellation.
      if (origin.current === 'hover' && !b.contains(document.activeElement)) { markWindowOverlayDismissal(event); close(); return }
      // 可见浮窗拥有本次 Escape；capture 先于原 Settings 的关闭处理，IME 始终归原输入。
      event.preventDefault(); event.stopPropagation()
      close()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true)
    return () => { connected = false; stop(); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true) }
  }, [open, visible])
  return <>
    <button ref={trigger} type="button" className="performance-trigger" aria-label={name} title={name} aria-expanded={open} data-toolkit-id={typeof toolId === 'string' ? toolId : undefined}
      aria-haspopup="dialog" onPointerEnter={enter} onPointerLeave={leave} onClick={promote}>
      {icon}{label ? <span>{name}</span> : null}
    </button>
    {open && visible ? <WindowOverlayPortal><div ref={panel} className="performance-popover" role="dialog" aria-label={name}
      style={{ visibility: 'hidden' }} onPointerEnter={() => clearTimeout(closeTimer.current)} onPointerLeave={leave}
      onFocusCapture={() => { clearTimeout(closeTimer.current); origin.current = 'explicit' }}>
      {children(close)}
    </div></WindowOverlayPortal> : null}
  </>
}
