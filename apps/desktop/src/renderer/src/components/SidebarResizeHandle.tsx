import type { ComponentPropsWithRef, KeyboardEvent, MouseEvent, SyntheticEvent } from 'react'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import './sidebar-resize-handle.css'

type SidebarResizeHandleProps = Pick<ComponentPropsWithRef<'div'>, 'ref' | 'className' | 'hidden' | 'title' | 'aria-label' | 'aria-controls'> & {
  width: number
  minWidth: number
  maxWidth: number
  resizing: boolean
  onWidthChange(width: number): void
  onResizeStart(event: MouseEvent): void
  onResizeReset(event: SyntheticEvent): void
}

const KEY_STEP = 16

/** Present the width edge. The caller owns live drag geometry and the saved width. */
export function SidebarResizeHandle({
  className, width, minWidth, maxWidth, resizing, onWidthChange, onResizeStart, onResizeReset, ...attributes
}: SidebarResizeHandleProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isImeOwnedKeyboardEvent(event)) return
    if (event.key === 'Enter') { onResizeReset(event); return }
    const next = event.key === 'Home' ? minWidth : event.key === 'End' ? maxWidth
      : event.key === 'ArrowLeft' ? width - KEY_STEP : event.key === 'ArrowRight' ? width + KEY_STEP : null
    if (next === null) return
    event.preventDefault()
    event.stopPropagation()
    onWidthChange(next)
  }
  return <div {...attributes} className={`sidebar-resize-handle${className ? ' ' + className : ''}`}
    role="separator" aria-orientation="vertical" tabIndex={0}
    aria-valuemin={minWidth} aria-valuemax={maxWidth} aria-valuenow={width} data-resizing={resizing || undefined}
    onMouseDown={onResizeStart} onDoubleClick={onResizeReset} onKeyDown={onKeyDown} />
}
