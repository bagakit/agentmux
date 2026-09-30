import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'
import { Activity } from 'lucide-react'
import { WindowOverlayPortal } from '../WindowOverlayHost'

/** 方案组件：原生焦点顺序；只负责本浮窗的进入与退出，不持有资源观察事实。 */
export function PerformancePopover({ children, label = false, onVisibleChange, focusKey }: {
  children(close: () => void): ReactNode
  label?: boolean
  onVisibleChange?(visible: boolean): void
  focusKey?: string
}) {
  const [open, setOpen] = useState(false)
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
    if (!open) openTimer.current = setTimeout(() => { origin.current = 'hover'; setOpen(true) }, 120)
  }
  const leave = () => {
    clearTimeout(openTimer.current)
    if (origin.current === 'hover' && !panel.current?.contains(document.activeElement))
      closeTimer.current = setTimeout(close, 180)
  }
  const promote = () => {
    cancel(); origin.current = 'explicit'; setOpen(true)
    if (open) panel.current?.querySelector<HTMLButtonElement>('[data-performance-close]')?.focus({ preventScroll: true })
  }
  useEffect(() => {
    const changed = () => { cancel(); setVisible(!document.hidden) }
    document.addEventListener('visibilitychange', changed)
    return () => { cancel(); document.removeEventListener('visibilitychange', changed) }
  }, [])
  useEffect(() => { onVisibleChange?.(open && visible); return () => onVisibleChange?.(false) }, [open, visible, onVisibleChange])
  useLayoutEffect(() => {
    if (open && visible && origin.current === 'explicit') panel.current?.querySelector<HTMLButtonElement>('[data-performance-close]')?.focus({ preventScroll: true })
  }, [focusKey])
  useLayoutEffect(() => {
    const a = trigger.current, b = panel.current
    if (!open || !visible || !a || !b) return
    let connected = true, placed = false
    const update = async () => {
      const { x, y } = await computePosition(a, b, { strategy: 'fixed', placement: 'top-start', middleware: [offset(8), flip(), shift({ padding: 12 })] })
      if (!connected) return
      Object.assign(b.style, { left: `${x}px`, top: `${y}px`, visibility: 'visible' })
      if (!placed && origin.current === 'explicit') b.querySelector<HTMLButtonElement>('[data-performance-close]')?.focus({ preventScroll: true })
      placed = true
    }
    const stop = autoUpdate(a, b, update)
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !a.contains(event.target) && !b.contains(event.target)) close(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return
      const target = event.target
      const passiveTerminal = origin.current === 'hover' && !b.contains(document.activeElement)
        && target instanceof HTMLElement && target.closest('.xterm') !== null
      if (passiveTerminal) { close(); return }
      // 可见浮窗拥有本次 Escape；capture 先于原 Settings 的关闭处理，IME 始终归原输入。
      event.preventDefault(); event.stopPropagation()
      close()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true)
    return () => { connected = false; stop(); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true) }
  }, [open, visible])
  return <>
    <button ref={trigger} type="button" className="performance-trigger" aria-label="Performance" aria-expanded={open}
      aria-haspopup="dialog" onPointerEnter={enter} onPointerLeave={leave} onClick={promote}>
      <Activity size={14} aria-hidden="true" />{label ? <span>Performance</span> : null}
    </button>
    {open && visible ? <WindowOverlayPortal><div ref={panel} className="performance-popover" role="dialog" aria-label="Performance"
      style={{ visibility: 'hidden' }} onPointerEnter={() => clearTimeout(closeTimer.current)} onPointerLeave={leave}
      onFocusCapture={() => { clearTimeout(closeTimer.current); origin.current = 'explicit' }}>
      {children(close)}
    </div></WindowOverlayPortal> : null}
  </>
}
